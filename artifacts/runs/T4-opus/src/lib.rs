#![forbid(unsafe_code)]

//! A thread-safe token-bucket rate limiter.
//!
//! # Model
//!
//! A bucket holds up to `capacity` tokens and gains `refill_per_sec` tokens per
//! second. Tokens are never refilled by a background thread: the token count is
//! recomputed lazily from the monotonic clock whenever the bucket is inspected.
//!
//! # Sharing
//!
//! [`RateLimiter`] is a cheap handle around an `Arc`. The intended pattern is to
//! build one and `clone()` it into each thread:
//!
//! ```
//! use ratelimit::RateLimiter;
//!
//! let limiter = RateLimiter::new(10, 100.0);
//! let worker = limiter.clone();
//! std::thread::spawn(move || {
//!     if worker.try_acquire(1) {
//!         // do the rate-limited thing
//!     }
//! })
//! .join()
//! .unwrap();
//! ```
//!
//! Wrapping it in another `Arc` works too but is redundant.
//!
//! # Fairness
//!
//! Blocking [`acquire`](RateLimiter::acquire) callers are served strictly FIFO
//! via a ticket queue, and the oldest blocked caller *reserves* the bucket:
//! while any caller is blocked, [`try_acquire`](RateLimiter::try_acquire) fails
//! and newer `acquire` callers wait behind it, even if enough tokens are
//! present. So a waiter for a large `n` can be overtaken only by requests that
//! arrived before it blocked — the unfairness it can suffer is bounded by the
//! tokens outstanding at that instant, not unbounded in time.
//!
//! # Time injection
//!
//! Tests can substitute a clock with [`RateLimiter::with_clock`]. See
//! [`Clock`] and [`RateLimiter::wake_waiters`].

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// A monotonic clock.
///
/// `now` returns the time elapsed since some fixed, arbitrary origin. It must
/// never go backwards.
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> Duration;
}

/// The process monotonic clock, based on [`Instant`].
#[derive(Debug)]
pub struct SystemClock {
    origin: Instant,
}

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock {
            origin: Instant::now(),
        }
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }
}

/// Longest single condvar wait for the head waiter. Only reached when refill
/// would take longer than this (or the rate is zero); it bounds nothing else.
const MAX_WAIT: Duration = Duration::from_secs(3600);

/// Floor on a computed wait, so float rounding on the last fraction of a token
/// cannot turn the wait loop into a spin.
const MIN_WAIT: Duration = Duration::from_micros(100);

#[derive(Debug)]
struct State {
    tokens: f64,
    /// Clock reading at which `tokens` was last brought up to date.
    last: Duration,
    /// Next ticket to hand out to a blocking caller.
    next_ticket: u64,
    /// Ticket currently entitled to the bucket. Equal to `next_ticket` when
    /// nobody is blocked.
    serving: u64,
}

#[derive(Debug)]
struct Inner {
    capacity: f64,
    rate: f64,
    clock: Box<dyn Clock>,
    state: Mutex<State>,
    ready: Condvar,
}

impl std::fmt::Debug for dyn Clock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Clock")
    }
}

/// A token-bucket rate limiter. Clone to share between threads.
#[derive(Clone, Debug)]
pub struct RateLimiter {
    inner: Arc<Inner>,
}

impl RateLimiter {
    /// Creates a limiter holding at most `capacity` tokens, refilling at
    /// `refill_per_sec` tokens per second, starting full.
    ///
    /// Panics if `refill_per_sec` is negative or not a number.
    pub fn new(capacity: u32, refill_per_sec: f64) -> Self {
        Self::with_clock(capacity, refill_per_sec, SystemClock::default())
    }

    /// Like [`new`](Self::new) but with an injected clock.
    pub fn with_clock<C: Clock>(capacity: u32, refill_per_sec: f64, clock: C) -> Self {
        assert!(
            refill_per_sec.is_finite() && refill_per_sec >= 0.0,
            "refill_per_sec must be finite and non-negative"
        );
        let start = clock.now();
        RateLimiter {
            inner: Arc::new(Inner {
                capacity: f64::from(capacity),
                rate: refill_per_sec,
                clock: Box::new(clock),
                state: Mutex::new(State {
                    tokens: f64::from(capacity),
                    last: start,
                    next_ticket: 0,
                    serving: 0,
                }),
                ready: Condvar::new(),
            }),
        }
    }

    /// Takes `n` tokens if they are available right now, returning whether it
    /// did. Never blocks.
    ///
    /// Returns `false` if `n` exceeds the capacity, or if a blocked
    /// [`acquire`](Self::acquire) caller currently holds the reservation (see
    /// the fairness note on the crate docs).
    pub fn try_acquire(&self, n: u32) -> bool {
        if n == 0 {
            return true;
        }
        let n = f64::from(n);
        if n > self.inner.capacity {
            return false;
        }
        let mut state = self.lock_refilled();
        if state.serving != state.next_ticket || state.tokens < n {
            return false;
        }
        state.tokens -= n;
        true
    }

    /// Takes `n` tokens, blocking until they are available.
    ///
    /// Callers are served in arrival order. Panics if `n` exceeds the capacity,
    /// which could never be satisfied.
    pub fn acquire(&self, n: u32) {
        if n == 0 {
            return;
        }
        let nf = f64::from(n);
        assert!(
            nf <= self.inner.capacity,
            "acquire({n}) exceeds capacity {}",
            self.inner.capacity
        );

        let mut state = self.lock_refilled();
        let ticket = state.next_ticket;
        state.next_ticket += 1;

        loop {
            if state.serving == ticket && state.tokens >= nf {
                state.tokens -= nf;
                state.serving += 1;
                drop(state);
                // Hand the reservation to the next waiter, if any.
                self.inner.ready.notify_all();
                return;
            }
            let timeout = if state.serving == ticket {
                self.time_until(nf - state.tokens)
            } else {
                // Not at the head: nothing to compute, we are woken when the
                // reservation moves. A long cap guards against a lost wakeup.
                MAX_WAIT
            };
            state = self.inner.ready.wait_timeout(state, timeout).unwrap().0;
            self.refill(&mut state);
        }
    }

    /// Tokens available right now, for diagnostics and tests.
    pub fn available(&self) -> f64 {
        self.lock_refilled().tokens
    }

    /// Number of callers blocked in [`acquire`](Self::acquire), for diagnostics
    /// and tests.
    pub fn waiting(&self) -> usize {
        let state = self.inner.state.lock().unwrap();
        (state.next_ticket - state.serving) as usize
    }

    /// Re-evaluates blocked callers against the current clock.
    ///
    /// Only needed with an injected [`Clock`]: with a real clock the limiter
    /// computes its own wakeup times, but it cannot know when a test clock has
    /// been advanced. Harmless to call at any time.
    pub fn wake_waiters(&self) {
        let _guard = self.inner.state.lock().unwrap();
        self.inner.ready.notify_all();
    }

    fn lock_refilled(&self) -> MutexGuard<'_, State> {
        let mut state = self.inner.state.lock().unwrap();
        self.refill(&mut state);
        state
    }

    /// Brings `tokens` up to date with the clock.
    fn refill(&self, state: &mut State) {
        let now = self.inner.clock.now();
        let Some(elapsed) = now.checked_sub(state.last) else {
            return; // clock did not advance
        };
        let added = elapsed.as_secs_f64() * self.inner.rate;
        if state.tokens + added >= self.inner.capacity {
            state.tokens = self.inner.capacity;
            state.last = now;
        } else if state.tokens + added > state.tokens {
            // Only bank the elapsed time when it actually moved the token
            // count. Otherwise `last` stays put and the remainder is credited
            // to a later refill, so sub-resolution intervals cannot drift away.
            state.tokens += added;
            state.last = now;
        }
    }

    /// How long until `need` more tokens have accrued.
    fn time_until(&self, need: f64) -> Duration {
        if need <= 0.0 || self.inner.rate <= 0.0 {
            return MAX_WAIT;
        }
        let secs = need / self.inner.rate;
        if !secs.is_finite() || secs >= MAX_WAIT.as_secs_f64() {
            MAX_WAIT
        } else {
            // Floored: a computed wait that rounds to ~zero would otherwise
            // re-check in a tight loop if the clock has not moved.
            Duration::from_secs_f64(secs).max(MIN_WAIT)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    /// A clock driven entirely by the test.
    #[derive(Clone, Default)]
    struct TestClock(Arc<Mutex<Duration>>);

    impl TestClock {
        fn advance(&self, d: Duration) {
            *self.0.lock().unwrap() += d;
        }
    }

    impl Clock for TestClock {
        fn now(&self) -> Duration {
            *self.0.lock().unwrap()
        }
    }

    fn limiter(capacity: u32, rate: f64) -> (RateLimiter, TestClock) {
        let clock = TestClock::default();
        (
            RateLimiter::with_clock(capacity, rate, clock.clone()),
            clock,
        )
    }

    /// Spins until `cond` holds. Used only to observe another thread reaching a
    /// blocked state; it does not advance any clock.
    fn wait_for(cond: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(Instant::now() < deadline, "condition never became true");
            std::thread::yield_now();
        }
    }

    #[test]
    fn exhaustion() {
        let (rl, _clock) = limiter(3, 1.0);
        assert!(rl.try_acquire(2));
        assert!(rl.try_acquire(1));
        assert!(!rl.try_acquire(1));
        assert_eq!(rl.available(), 0.0);
        // Never goes negative.
        assert!(!rl.try_acquire(3));
        assert_eq!(rl.available(), 0.0);
        // More than capacity is unsatisfiable, not a partial take.
        assert!(!rl.try_acquire(4));
        // n == 0 is always allowed and costs nothing.
        assert!(rl.try_acquire(0));
        assert_eq!(rl.available(), 0.0);
    }

    #[test]
    fn fractional_refill_math() {
        let (rl, clock) = limiter(10, 2.5);
        assert!(rl.try_acquire(10));
        assert_eq!(rl.available(), 0.0);

        clock.advance(Duration::from_millis(400)); // 1.0 token
        assert!((rl.available() - 1.0).abs() < 1e-9);
        assert!(rl.try_acquire(1));

        clock.advance(Duration::from_millis(100)); // 0.25 token
        assert!(!rl.try_acquire(1));
        clock.advance(Duration::from_millis(300)); // 0.75 more -> 1.0
        assert!(rl.try_acquire(1));
        assert!(rl.available().abs() < 1e-9);
    }

    #[test]
    fn no_drift_over_many_small_steps() {
        // 1000 steps of 1ms at 3 tokens/sec must credit 3 tokens, and the
        // remainder from steps too small to move the float must not be lost.
        let (rl, clock) = limiter(1000, 3.0);
        assert!(rl.try_acquire(1000));
        for _ in 0..1000 {
            clock.advance(Duration::from_millis(1));
            let _ = rl.available(); // force a refill at every step
        }
        assert!((rl.available() - 3.0).abs() < 1e-9, "{}", rl.available());

        // Steps so small that each one's contribution is individually below
        // the float resolution of the current token count. A naive
        // `last = now` on every refill would throw every one of them away and
        // the bucket would never gain a token; here the elapsed time banks
        // until it registers. Accuracy is limited to the ulp scale of the
        // token count, so the check is a factor-of-two band, not exact.
        let (rl, clock) = limiter(4_000_000_000, 0.0001);
        assert!(rl.try_acquire(1)); // drop below capacity so refill applies
        let base = rl.available();
        for _ in 0..1000 {
            clock.advance(Duration::from_millis(1)); // 1e-7 tokens, < 1 ulp
            let _ = rl.available();
        }
        let gained = rl.available() - base; // 1 second => ~0.0001 tokens
        assert!((0.00005..0.0002).contains(&gained), "{gained}");
    }

    #[test]
    fn saturation() {
        let (rl, clock) = limiter(5, 1000.0);
        clock.advance(Duration::from_secs(3600));
        assert_eq!(rl.available(), 5.0); // capped, never above capacity
        assert!(rl.try_acquire(5));
        assert!(!rl.try_acquire(1));

        // Time banked while full is discarded: refill restarts from now.
        clock.advance(Duration::from_millis(1));
        assert!((rl.available() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn concurrent_try_acquire_storm_conserves_tokens() {
        // No refill, so exactly `capacity` grants may ever succeed.
        let (rl, _clock) = limiter(500, 0.0);
        let granted = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let rl = rl.clone();
                let granted = granted.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for _ in 0..500 {
                        if rl.try_acquire(1) {
                            granted.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(granted.load(Ordering::Relaxed), 500);
        assert_eq!(rl.available(), 0.0);
    }

    #[test]
    fn concurrent_acquire_storm_conserves_tokens() {
        // 8 threads x 25 tokens = exactly the 200 tokens on hand; all must be
        // served and nothing may be created.
        let (rl, _clock) = limiter(200, 0.0);
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let rl = rl.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for _ in 0..25 {
                        rl.acquire(1);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(rl.available(), 0.0);
        assert_eq!(rl.waiting(), 0);
    }

    #[test]
    fn blocked_acquire_is_not_starved_by_try_acquire() {
        let (rl, clock) = limiter(10, 1.0);
        assert!(rl.try_acquire(10));

        let waiter = {
            let rl = rl.clone();
            std::thread::spawn(move || rl.acquire(5))
        };
        wait_for(|| rl.waiting() == 1);

        // Feed it a stream of small requests while tokens accrue. The waiter
        // owns the reservation, so none of them may take a token.
        for _ in 0..5 {
            clock.advance(Duration::from_secs(1));
            assert!(!rl.try_acquire(1), "try_acquire jumped the queue");
        }
        assert_eq!(rl.available(), 5.0);

        rl.wake_waiters();
        waiter.join().unwrap();
        assert_eq!(rl.waiting(), 0);
        assert_eq!(rl.available(), 0.0);

        // With the queue empty, try_acquire works again.
        clock.advance(Duration::from_secs(2));
        assert!(rl.try_acquire(2));
    }

    #[test]
    fn blocked_acquires_are_served_in_order() {
        let (rl, clock) = limiter(10, 1.0);
        assert!(rl.try_acquire(10));
        let order = Arc::new(Mutex::new(Vec::new()));

        let mut handles = Vec::new();
        for i in 0..3u32 {
            let (mine, order) = (rl.clone(), order.clone());
            handles.push(std::thread::spawn(move || {
                mine.acquire(2);
                order.lock().unwrap().push(i);
            }));
            // Ensure this caller is queued before the next one starts, so the
            // arrival order is the one under test.
            wait_for(|| rl.waiting() == i as usize + 1);
        }

        clock.advance(Duration::from_secs(6));
        rl.wake_waiters();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
    }

    /// The one test that uses real time. Budget: well under 500ms.
    #[test]
    fn smoke_real_clock() {
        let rl = RateLimiter::new(2, 100.0); // 10ms per token
        assert!(rl.try_acquire(2));
        assert!(!rl.try_acquire(1));

        let start = Instant::now();
        rl.acquire(2); // needs ~20ms of refill
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_millis(15), "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(400), "{elapsed:?}");
    }
}
