#![forbid(unsafe_code)]

//! A thread-safe, lazily refilled token-bucket rate limiter.
//!
//! [`RateLimiter`] is a cheap-to-clone handle: clones share one bucket and can
//! be moved directly into threads. Blocking acquisitions are queued FIFO.
//! While that queue is non-empty, [`RateLimiter::try_acquire`] does not take
//! tokens, so a stream of non-blocking callers cannot starve a blocking caller.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// A monotonic time source used by a [`RateLimiter`].
///
/// Values may have any epoch, but must never decrease. Tests and simulations
/// can implement this trait to supply virtual time.
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> Duration;
}

#[derive(Debug)]
struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }
}

/// A cloneable handle to a shared token bucket.
#[derive(Clone)]
pub struct RateLimiter {
    inner: Arc<Inner>,
}

struct Inner {
    capacity: f64,
    refill_per_sec: f64,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
    changed: Condvar,
}

struct State {
    tokens: f64,
    last_refill: Duration,
    next_ticket: u64,
    waiters: VecDeque<u64>,
}

impl RateLimiter {
    /// Creates a full bucket using the system monotonic clock.
    ///
    /// # Panics
    ///
    /// Panics if `capacity` is zero, or if `refill_per_sec` is not finite and
    /// strictly positive.
    pub fn new(capacity: u32, refill_per_sec: f64) -> Self {
        Self::with_clock(capacity, refill_per_sec, Arc::new(SystemClock::new()))
    }

    /// Creates a full bucket using an injected monotonic clock.
    ///
    /// A virtual clock should call [`notify_clock_advanced`](Self::notify_clock_advanced)
    /// after advancing while threads may be blocked.
    ///
    /// # Panics
    ///
    /// Panics under the same conditions as [`new`](Self::new).
    pub fn with_clock(capacity: u32, refill_per_sec: f64, clock: Arc<dyn Clock>) -> Self {
        assert!(capacity > 0, "capacity must be greater than zero");
        assert!(
            refill_per_sec.is_finite() && refill_per_sec > 0.0,
            "refill_per_sec must be finite and greater than zero"
        );

        let now = clock.now();
        Self {
            inner: Arc::new(Inner {
                capacity: f64::from(capacity),
                refill_per_sec,
                clock,
                state: Mutex::new(State {
                    tokens: f64::from(capacity),
                    last_refill: now,
                    next_ticket: 0,
                    waiters: VecDeque::new(),
                }),
                changed: Condvar::new(),
            }),
        }
    }

    /// Attempts to consume `n` tokens without blocking.
    ///
    /// Returns `false` when `n` exceeds the bucket capacity or when a blocking
    /// caller is queued. A zero-token acquisition always succeeds.
    pub fn try_acquire(&self, n: u32) -> bool {
        if n == 0 {
            return true;
        }
        if f64::from(n) > self.inner.capacity {
            return false;
        }

        let mut state = self.lock_state();
        self.refill(&mut state);
        if !state.waiters.is_empty() || state.tokens < f64::from(n) {
            return false;
        }

        state.tokens -= f64::from(n);
        true
    }

    /// Blocks until `n` tokens can be consumed.
    ///
    /// Blocking callers are served in FIFO order. Waiting uses a condition
    /// variable timed to the exact next eligibility instant; there is no
    /// background thread, busy-spin, or fixed polling interval.
    ///
    /// # Panics
    ///
    /// Panics if `n` exceeds the bucket capacity, because such an acquisition
    /// can never succeed.
    pub fn acquire(&self, n: u32) {
        if n == 0 {
            return;
        }
        assert!(
            f64::from(n) <= self.inner.capacity,
            "requested tokens exceed bucket capacity"
        );

        let mut state = self.lock_state();
        let ticket = state.next_ticket;
        state.next_ticket = state.next_ticket.wrapping_add(1);
        state.waiters.push_back(ticket);

        loop {
            self.refill(&mut state);
            let is_front = state.waiters.front() == Some(&ticket);
            if is_front && state.tokens >= f64::from(n) {
                state.tokens -= f64::from(n);
                state.waiters.pop_front();
                self.inner.changed.notify_all();
                return;
            }

            if is_front {
                let missing = f64::from(n) - state.tokens;
                let timeout = duration_until_tokens(missing, self.inner.refill_per_sec);
                state = self
                    .inner
                    .changed
                    .wait_timeout(state, timeout)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            } else {
                state = self
                    .inner
                    .changed
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
    }

    /// Wakes blocked callers after an injected clock has advanced.
    ///
    /// This is unnecessary with the system clock because timed waits wake at
    /// their computed eligibility instant.
    pub fn notify_clock_advanced(&self) {
        self.inner.changed.notify_all();
    }

    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn refill(&self, state: &mut State) {
        let now = self.inner.clock.now();
        let Some(elapsed) = now.checked_sub(state.last_refill) else {
            return;
        };
        if elapsed.is_zero() {
            return;
        }

        let added = elapsed.as_secs_f64() * self.inner.refill_per_sec;
        state.tokens = (state.tokens + added).min(self.inner.capacity);
        state.last_refill = now;
    }
}

fn duration_until_tokens(missing: f64, refill_per_sec: f64) -> Duration {
    debug_assert!(missing > 0.0);
    let seconds = missing / refill_per_sec;
    if seconds >= Duration::MAX.as_secs_f64() {
        return Duration::MAX;
    }

    // Round upward to a nanosecond so an early wake caused by conversion cannot
    // repeatedly shave fractional nanoseconds from the intended deadline.
    let nanos = (seconds * 1_000_000_000.0).ceil().max(1.0);
    Duration::from_secs_f64(nanos / 1_000_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::thread;

    #[derive(Default)]
    struct ManualClock {
        nanos: AtomicU64,
    }

    impl ManualClock {
        fn advance(&self, duration: Duration) {
            let nanos = u64::try_from(duration.as_nanos()).expect("test duration fits in u64");
            self.nanos.fetch_add(nanos, Ordering::SeqCst);
        }
    }

    impl Clock for ManualClock {
        fn now(&self) -> Duration {
            Duration::from_nanos(self.nanos.load(Ordering::SeqCst))
        }
    }

    fn virtual_limiter(capacity: u32, rate: f64) -> (RateLimiter, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::default());
        let limiter = RateLimiter::with_clock(capacity, rate, clock.clone());
        (limiter, clock)
    }

    fn wait_for_waiters(limiter: &RateLimiter, count: usize) {
        for _ in 0..100_000 {
            if limiter.lock_state().waiters.len() == count {
                return;
            }
            thread::yield_now();
        }
        panic!("waiters did not register");
    }

    #[test]
    fn exhaustion() {
        let (limiter, _) = virtual_limiter(3, 1.0);
        assert!(limiter.try_acquire(2));
        assert!(limiter.try_acquire(1));
        assert!(!limiter.try_acquire(1));
        assert!(limiter.try_acquire(0));
        assert!(!limiter.try_acquire(4));
    }

    #[test]
    fn fractional_refill_math_retains_partial_tokens() {
        let (limiter, clock) = virtual_limiter(2, 0.5);
        assert!(limiter.try_acquire(2));

        clock.advance(Duration::from_millis(1_999));
        assert!(!limiter.try_acquire(1));
        clock.advance(Duration::from_millis(1));
        assert!(limiter.try_acquire(1));

        clock.advance(Duration::from_secs(1));
        assert!(!limiter.try_acquire(1));
        clock.advance(Duration::from_secs(1));
        assert!(limiter.try_acquire(1));
    }

    #[test]
    fn concurrent_acquire_storm_conserves_tokens() {
        const INITIAL: usize = 5;
        const REFILLS: usize = 19;
        const TOTAL: usize = INITIAL + REFILLS;

        let (limiter, clock) = virtual_limiter(INITIAL as u32, 1.0);
        let completed = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..TOTAL {
            let limiter = limiter.clone();
            let completed = completed.clone();
            threads.push(thread::spawn(move || {
                limiter.acquire(1);
                completed.fetch_add(1, Ordering::SeqCst);
            }));
        }

        wait_for_waiters(&limiter, REFILLS);
        assert_eq!(completed.load(Ordering::SeqCst), INITIAL);
        for expected in (INITIAL + 1)..=TOTAL {
            clock.advance(Duration::from_secs(1));
            limiter.notify_clock_advanced();
            for _ in 0..100_000 {
                if completed.load(Ordering::SeqCst) == expected {
                    break;
                }
                thread::yield_now();
            }
            assert_eq!(completed.load(Ordering::SeqCst), expected);
        }

        for handle in threads {
            handle.join().unwrap();
        }
        assert_eq!(completed.load(Ordering::SeqCst), TOTAL);
        assert!(!limiter.try_acquire(1));
    }

    #[test]
    fn queued_large_acquire_cannot_be_starved_by_try_acquire() {
        let (limiter, clock) = virtual_limiter(2, 1.0);
        assert!(limiter.try_acquire(2));

        let waiting_limiter = limiter.clone();
        let waiter = thread::spawn(move || waiting_limiter.acquire(2));
        wait_for_waiters(&limiter, 1);

        clock.advance(Duration::from_secs(1));
        limiter.notify_clock_advanced();
        for _ in 0..1_000 {
            assert!(!limiter.try_acquire(1));
        }

        clock.advance(Duration::from_secs(1));
        limiter.notify_clock_advanced();
        waiter.join().unwrap();
        assert!(!limiter.try_acquire(1));
    }

    #[test]
    fn refill_saturates_at_capacity() {
        let (limiter, clock) = virtual_limiter(3, 2.5);
        assert!(limiter.try_acquire(3));
        clock.advance(Duration::from_secs(10_000));
        assert!(limiter.try_acquire(3));
        assert!(!limiter.try_acquire(1));
    }

    #[test]
    fn real_clock_blocking_smoke_test_finishes_quickly() {
        let limiter = RateLimiter::new(1, 100.0);
        assert!(limiter.try_acquire(1));
        let start = Instant::now();
        limiter.acquire(1);
        assert!(start.elapsed() < Duration::from_millis(500));
    }
}
