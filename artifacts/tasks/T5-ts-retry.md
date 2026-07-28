# T5 — TypeScript: typed resilience library

Implement a small resilience library in strict TypeScript for Node (`retry` + circuit breaker), tested with `node:test`. You may run `npm init -y` and install ONLY `typescript` and `@types/node` as devDependencies. tsconfig: `"strict": true`, `"exactOptionalPropertyTypes": true`, `"noUncheckedIndexedAccess": true`.

Requirements:
- `withRetry<T>(fn: (attempt: number, signal: AbortSignal) => Promise<T>, policy: RetryPolicy): Promise<T>`
  - Policy: max attempts, backoff (fixed | exponential with full jitter — injectable RNG), per-attempt timeout, total deadline, and `retryOn: (error: unknown) => boolean`.
  - Per-attempt timeout must abort the in-flight attempt via the AbortSignal, and the timer must be cleaned up on success (no open handles; test asserts the process would exit cleanly by checking no leaked timers via mock timers).
  - When the total deadline expires mid-backoff, reject with a `DeadlineError` carrying the last underlying error as `cause`.
- `CircuitBreaker<T>` wrapping an async fn: closed → open after N consecutive failures; open rejects fast with `CircuitOpenError`; after cooldown, half-open allows exactly ONE probe — concurrent calls during half-open must NOT all probe (this is the classic bug — test it); success closes, failure re-opens.
- Discriminated-union event stream: `onEvent(e: RetryEvent | CircuitEvent)` with exhaustive `switch` handling proven by a compile-time exhaustiveness check.
- No `any`, no `as` casts except at most one documented boundary, no timer-based flaky tests — inject a clock/timer abstraction.

Deliverables in this directory only: source, tsconfig, tests (`node --test` after `tsc` build, or tsx-free ts-node-free pipeline you set up), all green with zero tsc errors. Include tsc + test output tails in SUMMARY.md. `SUMMARY.md` as in T1. No AI model names anywhere. Simplicity counts; unnecessary layers count against you.
