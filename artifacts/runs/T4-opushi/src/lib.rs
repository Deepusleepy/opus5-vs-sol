#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! A thread-safe token-bucket rate limiter.
//!
//! std only: no dependencies, no async runtime, no background thread. Tokens
//! are refilled lazily from a monotonic clock whenever the bucket is
//! inspected.
//!
//! # Sharing
//!
//! [`RateLimiter`] is a handle around an `Arc`. Clone it once per thread and
//! move the clone; all clones share one bucket. Wrapping it in another `Arc`
//! works too but buys nothing.
//!
//! ```
//! use std::thread;
//! use ratelimit::RateLimiter;
//!
//! let limiter = RateLimiter::new(100, 50.0); // burst 100, 50 tokens/sec
//! let worker = limiter.clone();
//! thread::spawn(move || {
//!     worker.acquire(1); // blocks until a token is available
//! })
//! .join()
//! .unwrap();
//! ```
//!
//! # Fairness
//!
//! Blocked callers are served strictly first-come-first-served, and
//! [`try_acquire`](RateLimiter::try_acquire) defers to them: while any caller
//! is queued, `try_acquire` returns `false` even if the bucket is full. So a
//! waiter for a large `n` can never be starved by a stream of small
//! requests — it waits at most for the callers already ahead of it plus the
//! refill time for its own tokens. See the crate-level notes on
//! [`acquire`](RateLimiter::acquire) for the cost of that choice.

mod clock;
#[cfg(test)]
mod tests;

pub use clock::{Clock, ManualClock, SystemClock, Waker};

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

/// Smallest real-time park. Only reached when the computed wait rounds to
/// (near) zero, where parking for the exact figure could spin. It is a floor
/// on an exact deadline, not a polling interval.
const MIN_PARK: Duration = Duration::from_micros(1);

const POISONED: &str = "rate limiter mutex poisoned by an earlier panic";

/// A token bucket shared by cloning.
///
/// See the [crate docs](crate) for the sharing pattern and fairness rules.
#[derive(Clone)]
pub struct RateLimiter {
    inner: Arc<Inner>,
}

pub(crate) struct Inner {
    state: Mutex<State>,
    pub(crate) ready: Condvar,
    clock: Arc<dyn Clock>,
    capacity: u32,
    capacity_f64: f64,
    rate: f64,
}

struct State {
    /// Token count as of `anchor_time`. Refill is *computed* from this pair
    /// rather than accumulated into it, so repeated reads cannot drift: see
    /// [`Inner::available`].
    anchor_tokens: f64,
    anchor_time: Duration,
    /// Next FIFO ticket to hand out.
    next_ticket: u64,
    /// Ticket currently at the head of the line. `serving == next_ticket`
    /// means nobody is queued.
    serving: u64,
}

impl RateLimiter {
    /// Builds a limiter over the process monotonic clock.
    ///
    /// `capacity` is the burst size — the most tokens the bucket can hold,
    /// and the largest `n` any single call may request. `refill_per_sec` is
    /// the steady-state rate; fractional rates are exact.
    ///
    /// # Panics
    ///
    /// If `capacity` is zero, or `refill_per_sec` is not finite and greater
    /// than zero. Either would make some legal `acquire` block forever.
    pub fn new(capacity: u32, refill_per_sec: f64) -> Self {
        Self::with_clock(capacity, refill_per_sec, Arc::new(SystemClock::new()))
    }

    /// Builds a limiter over a caller-supplied clock, for tests.
    ///
    /// See [`ManualClock`] for the deterministic one. Panics under the same
    /// conditions as [`new`](Self::new).
    pub fn with_clock<C: Clock>(capacity: u32, refill_per_sec: f64, clock: Arc<C>) -> Self {
        assert!(capacity > 0, "capacity must be greater than zero");
        assert!(
            refill_per_sec.is_finite() && refill_per_sec > 0.0,
            "refill_per_sec must be finite and greater than zero, got {refill_per_sec}"
        );

        let clock: Arc<dyn Clock> = clock;
        let start = clock.now();
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                anchor_tokens: f64::from(capacity),
                anchor_time: start,
                next_ticket: 0,
                serving: 0,
            }),
            ready: Condvar::new(),
            clock,
            capacity,
            capacity_f64: f64::from(capacity),
            rate: refill_per_sec,
        });
        inner.clock.attach(Waker::new(&inner));
        Self { inner }
    }

    /// Takes `n` tokens if they are available right now.
    ///
    /// Never blocks. Returns `false` without taking anything if the tokens
    /// are not there *or* if another caller is queued in
    /// [`acquire`](Self::acquire) — deferring to queued callers is what keeps
    /// them from being starved. `n == 0` always succeeds and takes nothing.
    ///
    /// # Panics
    ///
    /// If `n` exceeds the limiter's capacity; that request could never be
    /// satisfied at any time, so it is treated as a bug rather than a
    /// permanent `false`.
    pub fn try_acquire(&self, n: u32) -> bool {
        let inner = &*self.inner;
        inner.check(n);
        if n == 0 {
            return true;
        }

        let mut st = inner.lock();
        if st.serving != st.next_ticket {
            return false; // somebody is queued; do not barge past them
        }
        let now = inner.clock.now();
        let need = f64::from(n);
        let avail = inner.available(&mut st, now);
        if avail < need {
            return false;
        }
        inner.take(&mut st, now, avail, need);
        true
    }

    /// Takes `n` tokens, blocking until they are available.
    ///
    /// Callers are queued and served in arrival order. The caller at the head
    /// of the line computes exactly when its tokens will exist and parks
    /// until then — no busy-spin and no polling interval. Because nothing may
    /// consume tokens ahead of the head caller, that deadline cannot be
    /// invalidated, so a satisfied waiter wakes once.
    ///
    /// The cost of strict ordering is that tokens accumulating for a large
    /// waiter are not lent to smaller requests in the meantime; throughput is
    /// traded for a starvation guarantee. `n == 0` returns immediately.
    ///
    /// # Panics
    ///
    /// If `n` exceeds the limiter's capacity.
    pub fn acquire(&self, n: u32) {
        let inner = &*self.inner;
        inner.check(n);
        if n == 0 {
            return;
        }
        let need = f64::from(n);

        let mut st = inner.lock();
        let ticket = st.next_ticket;
        st.next_ticket += 1;

        loop {
            if st.serving == ticket {
                let now = inner.clock.now();
                let avail = inner.available(&mut st, now);
                if avail >= need {
                    inner.take(&mut st, now, avail, need);
                    st.serving += 1;
                    drop(st);
                    // Wakes the next head; the others re-park.
                    inner.ready.notify_all();
                    return;
                }
                let wait = inner.time_until(avail, need);
                st = match inner.clock.condvar_timeout(wait) {
                    Some(t) => {
                        inner
                            .ready
                            .wait_timeout(st, t.max(MIN_PARK))
                            .expect(POISONED)
                            .0
                    }
                    None => inner.ready.wait(st).expect(POISONED),
                };
            } else {
                // Not our turn. The head notifies when it leaves.
                st = inner.ready.wait(st).expect(POISONED);
            }
        }
    }

    /// Burst size this limiter was built with.
    pub fn capacity(&self) -> u32 {
        self.inner.capacity
    }
}

impl Inner {
    pub(crate) fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect(POISONED)
    }

    fn check(&self, n: u32) {
        assert!(
            n <= self.capacity,
            "requested {n} tokens from a limiter with capacity {}; \
             this request can never be satisfied",
            self.capacity
        );
    }

    /// Tokens available at `now`.
    ///
    /// Computed from the anchor rather than accumulated, so a long run of
    /// reads adds no error: the result is always one multiply-add away from a
    /// point where the count was exact. The anchor only moves when tokens are
    /// taken, or when the bucket is full — re-anchoring at capacity is what
    /// discards overflow instead of banking it as credit.
    fn available(&self, st: &mut State, now: Duration) -> f64 {
        let elapsed = now.saturating_sub(st.anchor_time).as_secs_f64();
        let tokens = st.anchor_tokens + self.rate * elapsed;
        if tokens >= self.capacity_f64 {
            st.anchor_tokens = self.capacity_f64;
            st.anchor_time = now;
            return self.capacity_f64;
        }
        tokens
    }

    /// Removes `need` tokens, where `avail` is the result of
    /// [`available`](Self::available) at this same `now`.
    fn take(&self, st: &mut State, now: Duration, avail: f64, need: f64) {
        debug_assert!(avail >= need, "took more tokens than were available");
        // `avail` is never below `need` and both are non-negative, so this
        // cannot go negative; the clamp only absorbs subtraction rounding at
        // the exact-equality boundary.
        st.anchor_tokens = (avail - need).max(0.0);
        st.anchor_time = now;
    }

    /// How long until `need` tokens exist, given `avail` right now.
    fn time_until(&self, avail: f64, need: f64) -> Duration {
        let deficit = need - avail;
        if deficit <= 0.0 {
            return Duration::ZERO;
        }
        Duration::try_from_secs_f64(deficit / self.rate).unwrap_or(Duration::MAX)
    }
}

impl std::fmt::Debug for RateLimiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RateLimiter")
            .field("capacity", &self.inner.capacity)
            .field("refill_per_sec", &self.inner.rate)
            .finish_non_exhaustive()
    }
}
