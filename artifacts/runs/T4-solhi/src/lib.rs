#![forbid(unsafe_code)]

//! A thread-safe, lazily refilled token-bucket rate limiter.
//!
//! [`RateLimiter`] is a cheap-to-clone handle. Clone it and move one handle into
//! each thread, or wrap a handle in an `Arc` if that is more convenient for the
//! surrounding application.
//!
//! Blocking acquisitions are queued in FIFO order. While that queue is not
//! empty, [`RateLimiter::try_acquire`] cannot take tokens. Consequently, once a
//! blocking caller is queued, later blocking callers and non-blocking traffic
//! cannot bypass it. A caller can lose at most to an acquisition already in
//! progress when it joins the queue.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Supplies monotonic time to a [`RateLimiter`].
///
/// Implementations must not intentionally move backwards. The limiter clamps
/// an accidental backwards reading to the most recent reading it has used.
/// Durations may use any fixed origin; only differences between readings are
/// observed.
pub trait Clock: Send + Sync + 'static {
    /// Returns the current monotonic timestamp.
    fn now(&self) -> Duration;
}

impl<F> Clock for F
where
    F: Fn() -> Duration + Send + Sync + 'static,
{
    fn now(&self) -> Duration {
        self()
    }
}

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

/// A cloneable, thread-safe token-bucket rate limiter.
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
    /// Tokens available at `anchor`. Refill since `anchor` is calculated but
    /// not accumulated until an acquisition succeeds, avoiding rounding drift
    /// from repeated observations.
    tokens_at_anchor: f64,
    anchor: Duration,
    waiters: VecDeque<u64>,
    next_waiter: u64,
}

impl RateLimiter {
    /// Creates a full token bucket using the system monotonic clock.
    ///
    /// # Panics
    ///
    /// Panics if `capacity` is zero, or if `refill_per_sec` is not finite and
    /// positive. It also rejects rates so small that the time required to fill
    /// the bucket cannot be represented by [`Duration`].
    pub fn new(capacity: u32, refill_per_sec: f64) -> Self {
        Self::with_clock(capacity, refill_per_sec, SystemClock::new())
    }

    /// Creates a full token bucket using an injected monotonic clock.
    ///
    /// This constructor is useful for deterministic tests. A closure returning
    /// a [`Duration`] can be passed directly because suitable closures
    /// implement [`Clock`].
    ///
    /// # Panics
    ///
    /// Has the same validation rules as [`RateLimiter::new`].
    pub fn with_clock<C>(capacity: u32, refill_per_sec: f64, clock: C) -> Self
    where
        C: Clock,
    {
        assert!(capacity > 0, "capacity must be greater than zero");
        assert!(
            refill_per_sec.is_finite() && refill_per_sec > 0.0,
            "refill_per_sec must be finite and greater than zero"
        );

        let fill_seconds = f64::from(capacity) / refill_per_sec;
        assert!(
            fill_seconds.is_finite() && fill_seconds < Duration::MAX.as_secs_f64(),
            "bucket fill time must fit in Duration"
        );

        let clock: Arc<dyn Clock> = Arc::new(clock);
        let anchor = clock.now();
        Self {
            inner: Arc::new(Inner {
                capacity: f64::from(capacity),
                refill_per_sec,
                clock,
                state: Mutex::new(State {
                    tokens_at_anchor: f64::from(capacity),
                    anchor,
                    waiters: VecDeque::new(),
                    next_waiter: 0,
                }),
                changed: Condvar::new(),
            }),
        }
    }

    /// Attempts to take `n` tokens without blocking.
    ///
    /// Returns `false` if too few tokens are available, if `n` exceeds the
    /// bucket capacity, or if any blocking caller is queued. A request for zero
    /// tokens always succeeds.
    pub fn try_acquire(&self, n: u32) -> bool {
        if n == 0 {
            return true;
        }
        if f64::from(n) > self.inner.capacity {
            return false;
        }

        let mut state = self
            .inner
            .state
            .lock()
            .expect("rate limiter mutex poisoned");
        if !state.waiters.is_empty() {
            return false;
        }

        let now = self.monotonic_now(&state);
        let available = self.available_at(&state, now);
        if available < f64::from(n) {
            return false;
        }

        state.tokens_at_anchor = (available - f64::from(n)).max(0.0);
        state.anchor = now;
        true
    }

    /// Takes `n` tokens, blocking until they are available and this caller is
    /// at the head of the FIFO waiter queue.
    ///
    /// Waiting uses a condition variable with a timeout calculated from the
    /// exact token deficit. There is no polling interval or background thread.
    /// A request for zero tokens returns immediately.
    ///
    /// # Panics
    ///
    /// Panics if `n` exceeds the bucket capacity, because such a request can
    /// never complete.
    pub fn acquire(&self, n: u32) {
        if n == 0 {
            return;
        }
        assert!(
            f64::from(n) <= self.inner.capacity,
            "requested tokens exceed bucket capacity"
        );

        let mut state = self
            .inner
            .state
            .lock()
            .expect("rate limiter mutex poisoned");
        let waiter = state.next_waiter;
        state.next_waiter = state
            .next_waiter
            .checked_add(1)
            .expect("rate limiter waiter sequence exhausted");
        state.waiters.push_back(waiter);

        loop {
            while state.waiters.front() != Some(&waiter) {
                state = self
                    .inner
                    .changed
                    .wait(state)
                    .expect("rate limiter mutex poisoned");
            }

            let now = self.monotonic_now(&state);
            let available = self.available_at(&state, now);
            let requested = f64::from(n);
            if available >= requested {
                state.tokens_at_anchor = (available - requested).max(0.0);
                state.anchor = now;
                let removed = state.waiters.pop_front();
                debug_assert_eq!(removed, Some(waiter));
                drop(state);
                self.inner.changed.notify_all();
                return;
            }

            let wait_for = duration_ceil((requested - available) / self.inner.refill_per_sec);
            let (next_state, _) = self
                .inner
                .changed
                .wait_timeout(state, wait_for)
                .expect("rate limiter mutex poisoned");
            state = next_state;
        }
    }

    fn monotonic_now(&self, state: &State) -> Duration {
        self.inner.clock.now().max(state.anchor)
    }

    fn available_at(&self, state: &State, now: Duration) -> f64 {
        let elapsed = now.saturating_sub(state.anchor).as_secs_f64();
        (state.tokens_at_anchor + elapsed * self.inner.refill_per_sec).min(self.inner.capacity)
    }
}

fn duration_ceil(seconds: f64) -> Duration {
    debug_assert!(seconds.is_finite() && seconds > 0.0);
    let rounded = Duration::from_secs_f64(seconds);
    if rounded.is_zero() {
        return Duration::from_nanos(1);
    }
    if rounded.as_secs_f64() < seconds {
        rounded
            .checked_add(Duration::from_nanos(1))
            .unwrap_or(Duration::MAX)
    } else {
        rounded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Barrier, mpsc};
    use std::thread;

    #[derive(Clone, Default)]
    struct FakeClock {
        nanos: Arc<AtomicU64>,
        signal: Arc<Mutex<Option<mpsc::Sender<()>>>>,
    }

    impl FakeClock {
        fn advance(&self, duration: Duration) {
            let nanos = u64::try_from(duration.as_nanos()).expect("test duration fits in u64");
            self.nanos.fetch_add(nanos, Ordering::SeqCst);
        }

        fn signal_on_next_read(&self) -> mpsc::Receiver<()> {
            let (sender, receiver) = mpsc::channel();
            *self.signal.lock().expect("test clock mutex poisoned") = Some(sender);
            receiver
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Duration {
            if let Some(sender) = self
                .signal
                .lock()
                .expect("test clock mutex poisoned")
                .take()
            {
                sender.send(()).expect("clock observer still present");
            }
            Duration::from_nanos(self.nanos.load(Ordering::SeqCst))
        }
    }

    #[test]
    fn exhaustion() {
        let clock = FakeClock::default();
        let limiter = RateLimiter::with_clock(3, 1.0, clock);

        assert!(limiter.try_acquire(2));
        assert!(limiter.try_acquire(1));
        assert!(!limiter.try_acquire(1));
        assert!(limiter.try_acquire(0));
        assert!(!limiter.try_acquire(4));
    }

    #[test]
    fn fractional_refill_math_has_no_observation_drift() {
        let clock = FakeClock::default();
        let limiter = RateLimiter::with_clock(2, 0.25, clock.clone());
        assert!(limiter.try_acquire(2));

        clock.advance(Duration::from_millis(3_999));
        for _ in 0..1_000 {
            assert!(!limiter.try_acquire(1));
        }

        clock.advance(Duration::from_millis(1));
        assert!(limiter.try_acquire(1));
        clock.advance(Duration::from_secs(2));
        assert!(!limiter.try_acquire(1));
        clock.advance(Duration::from_secs(2));
        assert!(limiter.try_acquire(1));
        assert!(!limiter.try_acquire(1));
    }

    #[test]
    fn saturation_discards_time_spent_at_capacity() {
        let clock = FakeClock::default();
        let limiter = RateLimiter::with_clock(5, 2.0, clock.clone());

        clock.advance(Duration::from_secs(100));
        assert!(limiter.try_acquire(5));
        assert!(!limiter.try_acquire(1));

        clock.advance(Duration::from_secs(2));
        assert!(!limiter.try_acquire(5));
        clock.advance(Duration::from_millis(500));
        assert!(limiter.try_acquire(5));
        assert!(!limiter.try_acquire(1));
    }

    #[test]
    fn concurrent_acquire_storm_conserves_tokens() {
        const CAPACITY: u32 = 1_000;
        const THREADS: usize = 16;
        const ATTEMPTS_PER_THREAD: usize = 250;

        let limiter = RateLimiter::with_clock(CAPACITY, 1.0, FakeClock::default());
        let start = Arc::new(Barrier::new(THREADS + 1));
        let acquired = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();

        for _ in 0..THREADS {
            let limiter = limiter.clone();
            let start = start.clone();
            let acquired = acquired.clone();
            workers.push(thread::spawn(move || {
                start.wait();
                for _ in 0..ATTEMPTS_PER_THREAD {
                    if limiter.try_acquire(1) {
                        acquired.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }));
        }

        start.wait();
        for worker in workers {
            worker.join().expect("acquiring thread panicked");
        }

        assert_eq!(acquired.load(Ordering::Relaxed), CAPACITY as usize);
        assert!(!limiter.try_acquire(1));
    }

    #[test]
    fn queued_large_acquire_cannot_be_starved_by_small_try_acquires() {
        let clock = FakeClock::default();
        let limiter = RateLimiter::with_clock(10, 1.0, clock.clone());
        assert!(limiter.try_acquire(10));

        let waiter_read_clock = clock.signal_on_next_read();
        let (finished_tx, finished_rx) = mpsc::channel();
        let blocking = limiter.clone();
        let waiter = thread::spawn(move || {
            blocking.acquire(10);
            finished_tx.send(()).expect("test receiver present");
        });

        waiter_read_clock
            .recv_timeout(Duration::from_secs(1))
            .expect("blocking caller reached the waiter queue");

        // At each one-token refill, non-blocking traffic would consume the new
        // token and keep the ten-token request waiting forever without the
        // waiter-queue gate. Wake the head after every denied attempt so the
        // test also exercises partial-refill Condvar wakeups.
        for _ in 0..10 {
            clock.advance(Duration::from_secs(1));
            // Taking the mutex through try_acquire guarantees the blocking
            // caller is waiting before this iteration's explicit wakeup.
            assert!(!limiter.try_acquire(1));
            let waiter_read_clock = clock.signal_on_next_read();
            limiter.inner.changed.notify_all();
            waiter_read_clock
                .recv_timeout(Duration::from_secs(1))
                .expect("blocking caller observed the advanced clock");
        }

        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("large queued acquisition completed first");
        waiter.join().expect("blocking caller panicked");
        assert!(!limiter.try_acquire(1));
    }

    #[test]
    fn blocking_acquire_uses_real_condvar_timeout_smoke() {
        let limiter = RateLimiter::new(1, 100.0);
        assert!(limiter.try_acquire(1));

        let started = Instant::now();
        limiter.acquire(1);
        let elapsed = started.elapsed();

        assert!(elapsed >= Duration::from_millis(5));
        assert!(elapsed < Duration::from_millis(500));
    }

    #[test]
    #[should_panic(expected = "requested tokens exceed bucket capacity")]
    fn blocking_request_larger_than_capacity_panics() {
        RateLimiter::with_clock(2, 1.0, FakeClock::default()).acquire(3);
    }

    #[test]
    fn duration_rounds_up_to_avoid_early_timeout_spin() {
        assert_eq!(duration_ceil(0.4e-9), Duration::from_nanos(1));
        assert_eq!(duration_ceil(1.1e-9), Duration::from_nanos(2));
        assert_eq!(duration_ceil(2.0), Duration::from_secs(2));
    }
}
