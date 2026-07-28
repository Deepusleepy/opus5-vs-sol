//! Time sources for [`RateLimiter`](crate::RateLimiter).
//!
//! The limiter never reads the clock directly: it calls [`Clock::now`] for
//! refill math and [`Clock::condvar_timeout`] to decide how long a blocked
//! caller should park. Swapping in [`ManualClock`] therefore makes blocking
//! behaviour fully deterministic without any real sleeping.

use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use crate::Inner;

/// A monotonic time source.
///
/// `now` must never go backwards. The origin is arbitrary — only differences
/// are used.
pub trait Clock: Send + Sync + 'static {
    /// Elapsed time since this clock's (arbitrary, fixed) origin.
    fn now(&self) -> Duration;

    /// Translate "the limiter needs `wait` more of *clock* time" into a real
    /// timeout for the internal condvar.
    ///
    /// `Some(d)` parks for at most `d` of real time; `None` parks until
    /// something calls [`Waker::wake`]. Clocks whose time only moves when a
    /// test says so return `None` — a real-time timeout would be meaningless
    /// for them, and the limiter would either spin or stall.
    fn condvar_timeout(&self, wait: Duration) -> Option<Duration> {
        Some(wait)
    }

    /// Hand the clock a way to wake limiters that are parked on it.
    ///
    /// Called once per limiter, at construction. Clocks driven by real time
    /// ignore this (the default). Clocks whose time is set programmatically
    /// must keep the waker and call [`Waker::wake`] after moving time,
    /// otherwise blocked callers will not notice.
    fn attach(&self, waker: Waker) {
        let _ = waker;
    }
}

/// Wakes every caller blocked in `acquire` on one limiter so they re-check
/// the clock. Held by [`Clock`] implementations that move time by hand.
///
/// Holds a weak reference: keeping a waker alive does not keep the limiter
/// alive, and waking a dropped limiter is a no-op.
#[derive(Clone)]
pub struct Waker {
    inner: Weak<Inner>,
}

impl Waker {
    pub(crate) fn new(inner: &Arc<Inner>) -> Self {
        Self {
            inner: Arc::downgrade(inner),
        }
    }

    /// Re-check the clock on every blocked caller.
    pub fn wake(&self) {
        if let Some(inner) = self.inner.upgrade() {
            // Taking the state lock first is what makes the wakeup reliable:
            // a caller that has decided to park but has not reached the
            // condvar yet still holds this lock, so we cannot slip a
            // notification into the gap and have it lost.
            let _guard = inner.lock();
            inner.ready.notify_all();
        }
    }
}

impl std::fmt::Debug for Waker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Waker")
    }
}

/// The process monotonic clock ([`Instant`]). Default for
/// [`RateLimiter::new`](crate::RateLimiter::new).
#[derive(Debug)]
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    /// Anchors a new clock at the current instant.
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }
}

/// A clock that only moves when [`advance`](ManualClock::advance) is called.
///
/// ```
/// use std::time::Duration;
/// use ratelimit::{ManualClock, RateLimiter};
///
/// let clock = ManualClock::new();
/// let limiter = RateLimiter::with_clock(1, 2.0, clock.clone());
/// assert!(limiter.try_acquire(1));
/// assert!(!limiter.try_acquire(1));
/// clock.advance(Duration::from_millis(500)); // 2 tokens/s -> 1 token
/// assert!(limiter.try_acquire(1));
/// ```
#[derive(Debug)]
pub struct ManualClock {
    state: Mutex<ManualState>,
}

#[derive(Debug)]
struct ManualState {
    now: Duration,
    wakers: Vec<Waker>,
}

impl ManualClock {
    /// Starts at zero. Returned pre-wrapped because a clock is always shared
    /// with at least one limiter.
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ManualState {
                now: Duration::ZERO,
                wakers: Vec::new(),
            }),
        })
    }

    /// Move time forward and wake anything blocked on a limiter using this
    /// clock.
    pub fn advance(&self, by: Duration) {
        // The wakers are cloned out and invoked with this lock released.
        // A blocked caller holds the limiter's state lock while calling
        // `now()`, which takes this lock; waking while holding this lock
        // would invert that order and deadlock.
        let wakers = {
            let mut state = self.lock();
            state.now += by;
            state.wakers.clone()
        };
        for waker in &wakers {
            waker.wake();
        }
    }

    fn lock(&self) -> MutexGuard<'_, ManualState> {
        self.state
            .lock()
            .expect("manual clock mutex poisoned by an unrelated panic")
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Duration {
        self.lock().now
    }

    fn condvar_timeout(&self, _wait: Duration) -> Option<Duration> {
        None
    }

    fn attach(&self, waker: Waker) {
        self.lock().wakers.push(waker);
    }
}
