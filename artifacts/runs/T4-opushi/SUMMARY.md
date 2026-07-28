# ratelimit — concurrent token-bucket rate limiter

A thread-safe token bucket as a Rust library crate. std only: no dependencies,
no async runtime, no background thread. `#![forbid(unsafe_code)]`.

## What I built

- `src/lib.rs` — the limiter: bucket state, FIFO queue, condvar blocking.
- `src/clock.rs` — the injectable time source: `Clock`, `SystemClock`,
  `ManualClock`, `Waker`.
- `src/tests.rs` — 29 unit tests, plus 2 doc-tests.

### API

```rust
RateLimiter::new(capacity: u32, refill_per_sec: f64) -> RateLimiter
RateLimiter::with_clock<C: Clock>(capacity, refill_per_sec, Arc<C>) -> RateLimiter
fn try_acquire(&self, n: u32) -> bool   // non-blocking
fn acquire(&self, n: u32)               // blocking
fn capacity(&self) -> u32
```

**Sharing pattern:** `RateLimiter` is a handle wrapping an `Arc`. Clone it once
per thread and move the clone — all clones share one bucket. Wrapping it in a
further `Arc` works but buys nothing.

`capacity` doubles as the largest legal `n`. Requesting more panics rather than
returning a permanent `false`, because no amount of waiting could satisfy it.
Zero capacity, and non-finite or non-positive rates, panic at construction for
the same reason: they would make some legal `acquire` block forever.

### Refill math

State is an anchor pair — `(tokens_at_anchor, anchor_time)` — and availability
is *computed* from it, `anchor + rate * elapsed`, never accumulated into it.
Repeated reads therefore add no error: every answer is one multiply-add away
from a point where the count was exact, so a long run of checks cannot drift.
The anchor advances only when tokens are taken or when the bucket hits capacity;
re-anchoring at the ceiling is what discards overflow instead of banking it as
credit. Elapsed time comes from a monotonic source via `saturating_sub`, so a
clock that fails to advance yields zero rather than a negative interval.

### Fairness approach

Blocked callers take a ticket and are served strictly first-come-first-served,
and `try_acquire` defers to them: **while any caller is queued, `try_acquire`
returns `false` even if the bucket is full.**

That single rule is what bounds unfairness. A waiter for a large `n` waits at
most for the callers already ahead of it plus the refill time for its own
tokens — a stream of small `try_acquire` calls cannot extend that wait at all,
because none of them can take a token while the waiter is queued. Only the
caller at the head of the line may consume, so its computed deadline can never
be invalidated by someone else draining the bucket underneath it.

The cost is deliberate: tokens accumulating for a large waiter are not lent to
smaller requests in the meantime, so throughput is traded for the starvation
guarantee. Documented on `acquire`.

### Blocking without spinning

The head waiter computes exactly how long until its tokens exist
(`deficit / rate`) and parks on a condvar for that duration — not a polling
interval. Non-head waiters park with no timeout and are woken when the head
departs. Verified empirically rather than assumed: instrumenting the park site
showed **one park per blocking call** across the real-clock smoke test.

`Clock::condvar_timeout` is the seam that makes this testable. `SystemClock`
returns the computed wait; `ManualClock` returns `None`, so waiters park
indefinitely and are released by `Waker` when a test advances time. A real-time
timeout would be meaningless for a hand-driven clock — the limiter would either
spin or stall.

## How to verify

```
cargo test                              # 29 unit + 2 doc tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

Tests are deterministic via `ManualClock`. Exactly one test touches real time
(`smoke_real_clock_blocks_for_about_the_right_time`); the whole binary runs in
**~0.06s**, well under the 500ms cap. Threads are synchronized by spinning on
observable limiter state with a 10s deadline, so a regression fails with a
diagnostic instead of hanging the suite.

### Test output tail

```
running 29 tests
test tests::acquire_returns_immediately_when_tokens_are_present ... ok
test tests::capacity_sized_request_is_satisfiable ... ok
test tests::clones_share_one_bucket ... ok
test tests::exhaustion_is_exact_for_multi_token_requests ... ok
test tests::fractional_rate_below_one_per_second_accumulates_exactly ... ok
test tests::idle_bucket_saturates_at_capacity ... ok
test tests::acquire_beyond_capacity_is_rejected - should panic ... ok
test tests::partial_use_then_long_idle_still_caps_at_capacity ... ok
test tests::refills_at_a_fractional_rate ... ok
test tests::nan_rate_is_rejected - should panic ... ok
test tests::saturation_does_not_bank_credit_for_later ... ok
test tests::starts_full_and_exhausts_at_capacity ... ok
test tests::try_acquire_beyond_capacity_is_rejected - should panic ... ok
test tests::sub_millisecond_refill_is_not_rounded_away ... ok
test tests::tokens_never_go_negative ... ok
test tests::waking_a_dropped_limiter_is_harmless ... ok
test tests::zero_tokens_is_free_and_never_blocks ... ok
test tests::zero_capacity_is_rejected - should panic ... ok
test tests::zero_rate_is_rejected - should panic ... ok
test tests::repeated_take_and_check_does_not_drift ... ok
test tests::try_acquire_storm_issues_each_token_exactly_once ... ok
test tests::a_queued_waiter_blocks_barging_try_acquires ... ok
test tests::waiters_are_served_in_arrival_order ... ok
test tests::mixed_storm_of_acquire_and_try_acquire_conserves_tokens ... ok
test tests::concurrent_acquire_storm_conserves_tokens ... ok
test tests::a_departing_waiter_hands_off_to_the_whole_queue ... ok
test tests::a_large_waiter_is_not_starved_by_a_stream_of_small_acquires ... ok
test tests::acquire_blocks_until_the_clock_provides_tokens ... ok
test tests::smoke_real_clock_blocks_for_about_the_right_time ... ok

test result: ok. 29 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s

   Doc-tests ratelimit

running 2 tests
test src/clock.rs - clock::ManualClock (line 109) ... ok
test src/lib.rs - (line 16) ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.86s
```

Coverage of the required cases: exhaustion (`starts_full_and_exhausts_at_capacity`,
`exhaustion_is_exact_for_multi_token_requests`), fractional-rate refill
(`refills_at_a_fractional_rate` at 0.5/s,
`fractional_rate_below_one_per_second_accumulates_exactly` at 1/3 per second,
`sub_millisecond_refill_is_not_rounded_away` at nanosecond granularity), drift
(`repeated_take_and_check_does_not_drift`, 5000 rounds pinning the banked
residue to 0.005 tokens within 1ms), concurrent storms
(`concurrent_acquire_storm_conserves_tokens` with 40 threads,
`try_acquire_storm_issues_each_token_exactly_once` with 16 threads x 500
attempts, `mixed_storm_...` mixing both call styles), fairness
(`a_large_waiter_is_not_starved_by_a_stream_of_small_acquires`,
`a_queued_waiter_blocks_barging_try_acquires`,
`waiters_are_served_in_arrival_order`), and saturation
(`idle_bucket_saturates_at_capacity`, `saturation_does_not_bank_credit_for_later`,
`partial_use_then_long_idle_still_caps_at_capacity`).

## Verification beyond "the tests pass"

Green tests only prove the code does what it does, so I checked the suite
against deliberately broken implementations. Eight mutations of `lib.rs`; each
was reverted afterward.

| Mutation | Result |
|---|---|
| Remove the `try_acquire` deferral to queued waiters | killed by both barging tests |
| Accumulate refill into the anchor, rounded to ms | killed by the drift/precision/smoke tests |
| Remove the capacity ceiling | killed by 4 saturation tests |
| Let any waiter take, not just the head (breaks FIFO) | killed by 4 ordering/conservation tests |
| Fixed 250ms polling instead of a computed deadline | killed by the smoke test |
| Over-deduct on take (drives tokens negative) | killed by 20 tests |
| `notify_one` instead of `notify_all` on departure | **survived initially — see below** |
| Clamp at capacity without re-anchoring | survived; verified behaviourally equivalent, since `take` always re-anchors from the clamped value |

Two findings worth stating plainly:

1. **The `notify_one` mutation exposed a real gap.** Waking a single waiter
   strands the queue whenever the woken thread is not the next head, but every
   existing test happened to advance `ManualClock` at the decisive moment, and
   `advance` broadcasts — masking the lost wakeup. I added
   `a_departing_waiter_hands_off_to_the_whole_queue`, where 30 followers must
   drain on the limiter's own notifications with no intervening clock event.
   It passes on the correct code and fails the mutant in 10s with a clear
   message instead of hanging.

2. **Two fairness tests were genuinely flaky, and I only caught it by looking.**
   Repeat-running exposed 3 failures in 30 release-mode runs. The bug was in the
   tests, not the limiter: they recorded service order by pushing to a shared
   `Vec` *after* `acquire` returned, so the returning threads raced each other
   even though the limiter's grant order was correct. Rewritten to assert
   against per-waiter flags checked at each clock step, which observes grant
   order rather than scheduler order. Now **0 failures in 60 release runs and 60
   debug runs**, and the rewritten tests still kill the FIFO mutation.

## Known limitations

- **Strict FIFO costs throughput.** While a large waiter is queued, arriving
  small requests are refused even though the bucket could serve them. This is
  the deliberate trade for the starvation bound; a limiter optimizing for
  throughput would want a different policy.
- **No timeout or cancellation on `acquire`.** A blocked caller waits until
  served. Nothing in the design prevents adding `acquire_timeout` — the deadline
  math is already there — but the task did not ask for it.
- **Mutex poisoning panics.** If a thread panics while holding the bucket lock,
  subsequent calls panic with a clear message rather than attempting recovery.
- **`f64` state.** Fine for realistic capacities and rates; at extreme rates
  (approaching 2^53 tokens per second) the arithmetic would lose precision. A
  fixed-point representation would be the fix if that ever mattered.
- **One global queue per limiter.** Every waiter contends on a single mutex.
  Adequate at the scale a token bucket is normally used for; a limiter under
  extreme thread counts would want sharding.
