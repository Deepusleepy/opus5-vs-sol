# T4 — `ratelimit`: concurrent token-bucket rate limiter

## What I built

A single-file Rust library crate (`src/lib.rs`, `#![forbid(unsafe_code)]`, std only, no
dependencies, no async runtime) implementing a thread-safe token bucket.

**API**

- `RateLimiter::new(capacity: u32, refill_per_sec: f64)` — bucket starts full.
- `RateLimiter::with_clock(capacity, refill_per_sec, clock)` — same, with an injected clock.
- `try_acquire(n: u32) -> bool` — non-blocking.
- `acquire(n: u32)` — blocking, FIFO.
- `available() -> f64`, `waiting() -> usize` — diagnostics/tests.
- `wake_waiters()` — re-evaluates blocked callers against the current clock; only needed
  when driving an injected clock (see below).
- `trait Clock { fn now(&self) -> Duration }`, `struct SystemClock` (wraps `Instant`).

**Sharing pattern.** `RateLimiter` is a cheap handle around an internal `Arc<Inner>` and is
`Clone + Send + Sync`. The intended use is to build one and `clone()` it into each thread;
an outer `Arc` works but is redundant. This is documented in the crate docs, with a doctest
showing the pattern.

**No background thread.** State is `Mutex<{ tokens, last, next_ticket, serving }>` plus one
`Condvar`. The token count is brought up to date from the monotonic clock on every lock
acquisition (`refill`), so refill is entirely lazy.

**Blocking without spinning or polling.** A blocked caller computes exactly how long it
needs — `(n - tokens) / rate` — and does a single `Condvar::wait_timeout` for that duration.
It is not a fixed poll interval: each wait is sized to the actual token deficit, so the
common case is one wait and one wakeup. Waiters that are not at the head of the queue do no
timing math at all; they wait until the reservation is handed to them (with an hour cap as a
lost-wakeup guard). A `MIN_WAIT` floor of 100µs prevents float rounding on the last fraction
of a token from turning the wait into a spin.

## Fairness approach

Blocking callers take a monotonically increasing ticket; `serving` names the ticket
currently entitled to the bucket. Two consequences:

1. `acquire` callers are served strictly FIFO — a large `n` cannot be overtaken by later
   `acquire` calls for a small `n`.
2. While anyone is blocked, `try_acquire` returns `false` regardless of the token count. The
   head waiter *reserves* the bucket, so an unbounded stream of small `try_acquire` calls
   cannot starve it.

So unfairness is bounded: a waiter for large `n` can only be overtaken by requests that were
already granted before it blocked, never by an unbounded stream arriving afterwards. The
trade-off is deliberate and worth stating — `try_acquire` will fail while a waiter is
queued even if tokens are sitting in the bucket. That is the price of the starvation
guarantee, and for a rate limiter it is the right side of the trade.

Tested by `blocked_acquire_is_not_starved_by_try_acquire` (5 rounds of refill + `try_acquire`
while a waiter for 5 tokens is blocked — all rejected, waiter then served) and
`blocked_acquires_are_served_in_order` (three waiters, asserted completion order).

## Duration / float care

- **No drift.** `last` is only advanced when the elapsed time actually moves the token
  count. If a refill interval is too small to register against the current float token
  count, `last` is left where it is and the time banks for a later refill instead of being
  silently discarded. `no_drift_over_many_small_steps` exercises both scales: 1000 × 1ms
  steps summing exactly, and 1000 steps whose individual contribution is below one ulp of
  the token count (which a naive `last = now` would lose entirely).
- **No negative tokens.** Tokens are only decremented after a `tokens >= n` check under the
  lock; `try_acquire` on an empty bucket leaves it at exactly `0.0`.
- **Saturation.** `refill` clamps to capacity and resets `last` to now, so time banked while
  full is discarded rather than credited later as a burst.
- **`n > capacity`.** Unsatisfiable, so `try_acquire` returns `false` immediately (no partial
  take) and `acquire` panics rather than blocking forever.
- `clock.now()` is subtracted with `checked_sub`, so a clock that fails to advance is a
  no-op rather than a wrap.

## Time injection and determinism

Tests use a `TestClock` (an `Arc<Mutex<Duration>>`) and advance it explicitly. Because the
limiter cannot observe a test clock jumping forward, `wake_waiters()` re-evaluates blocked
callers; tests call it after advancing. The only test that consumes real time is
`smoke_real_clock` (100 tokens/sec, one `acquire(2)`, ~20ms) — well inside the 500ms
budget; the full suite runs in ~0.03s. Two helper spin-waits (`wait_for`) synchronize on
another thread *reaching* a blocked state; they yield rather than sleep and advance no clock.

## How to verify

```
cargo test
cargo clippy --all-targets   # clean
cargo fmt --check            # clean
```

`cargo test` output tail:

```
running 9 tests
test tests::exhaustion ... ok
test tests::fractional_refill_math ... ok
test tests::saturation ... ok
test tests::concurrent_acquire_storm_conserves_tokens ... ok
test tests::no_drift_over_many_small_steps ... ok
test tests::blocked_acquire_is_not_starved_by_try_acquire ... ok
test tests::concurrent_try_acquire_storm_conserves_tokens ... ok
test tests::blocked_acquires_are_served_in_order ... ok
test tests::smoke_real_clock ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

   Doc-tests ratelimit

running 1 test
test src/lib.rs - (line 16) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.50s
```

Test coverage: exhaustion (including zero-floor and `n > capacity`), fractional refill at
2.5 tokens/sec, drift over many small steps at two scales, saturation, a concurrent
`try_acquire` storm (8 threads × 500 attempts against 500 tokens, asserts exactly 500 grants
— tokens conserved, none created), a concurrent `acquire` storm (8 threads × 25 acquires
against exactly 200 tokens, asserts all complete and the bucket lands at exactly 0),
fairness vs. `try_acquire`, FIFO ordering, and the real-clock smoke test. The suite was run
5× consecutively with no flakes.

## Known limitations

- `try_acquire` is blocked while any `acquire` waiter is queued (the fairness trade-off
  above). If you want `try_acquire` to be purely opportunistic, that is a different policy.
- Waiters are woken with `notify_all` on each grant. With a very large number of blocked
  threads this is a thundering herd; a per-ticket condvar would fix it, but at this scale
  the complexity is not earned.
- `acquire` has no timeout or cancellation. Nothing in the requirements asked for one, and
  adding it speculatively would widen the API surface.
- Token accounting is `f64`. At the extremes (capacities near 2^53, or rates many orders of
  magnitude below the token count) refill resolution is limited by float ulp — the banking
  logic keeps this from becoming systematic drift, but individual reads can be off by an
  ulp. Fixed-point nanotokens would remove this; it is not worth it for realistic capacities.
- `Clock::now` is called under the state mutex. A pathologically slow clock implementation
  would serialize callers.
