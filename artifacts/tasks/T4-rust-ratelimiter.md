# T4 — Rust: concurrent token-bucket rate limiter

Implement a thread-safe token-bucket rate limiter as a Rust library crate `ratelimit` (std only, no external dependencies, no async runtime).

Requirements:
- `RateLimiter::new(capacity: u32, refill_per_sec: f64)`; shared across threads (`Clone` handle or `Arc`-friendly; document the intended pattern).
- `try_acquire(n: u32) -> bool` (non-blocking) and `acquire(n: u32)` (blocking with correct wakeups — no busy-spin, no fixed-interval polling; use Condvar timing math).
- Refill is computed lazily from elapsed time (monotonic clock) — no background thread.
- `acquire` calls must be served with bounded unfairness: a waiter for a large n must not be starved forever by a stream of small try_acquires; document and test your fairness approach.
- Time must be injectable (trait or closure) so tests are deterministic — tests must not sleep for real time except one smoke test capped under 500ms total.
- Careful float/duration math: no drift accumulation, no negative-token states, capacity saturation correct.

Deliverables in this directory only:
- Crate with unit tests: exhaustion, refill math at fractional rates, concurrent acquire storm (threads, assert total tokens conserved), fairness test with injected clock, saturation.
- `cargo test` green; output tail in SUMMARY.md. `#![forbid(unsafe_code)]`.
- `SUMMARY.md` as in T1. No AI model names anywhere. Simplicity counts.
