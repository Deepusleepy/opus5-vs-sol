# T5 — Typed resilience library

A small resilience library for Node in strict TypeScript: `withRetry` and
`CircuitBreaker`, plus a discriminated-union event stream shared by both.
Tests run on `node:test` against the compiled output. No runtime dependencies;
`typescript` and `@types/node` are the only devDependencies.

## What I built

```
src/clock.ts             Clock abstraction + systemClock (the only time dependency)
src/errors.ts            TimeoutError, DeadlineError, CircuitOpenError
src/events.ts            RetryEvent | CircuitEvent union + assertNever
src/retry.ts             withRetry
src/circuit-breaker.ts   CircuitBreaker
src/index.ts             public surface

test/fake-clock.ts            deterministic Clock used by every test
test/retry.test.ts            23 tests
test/circuit-breaker.test.ts  15 tests
test/events.test.ts           3 tests
type-tests/missing-case.ts    negative fixture: must NOT compile
```

### `withRetry`

```ts
withRetry<T>(fn: (attempt: number, signal: AbortSignal) => Promise<T>,
             policy: RetryPolicy): Promise<T>
```

The policy carries max attempts, backoff (`fixed` or `exponential` with full
jitter), `retryOn`, an optional per-attempt timeout, an optional total
deadline, and injectable `clock` / `rng` / `onEvent`.

Points worth calling out:

- **The per-attempt timeout really aborts.** Each attempt gets an
  `AbortController`; on expiry the signal is aborted with the `TimeoutError`
  as `signal.reason` *and* the attempt's promise rejects, so a function that
  ignores its signal cannot hold the retry loop open.
- **The timer is always cleared.** Success, failure, and a synchronous throw
  from `fn` all run through one `settle()` path that cancels the timer before
  resolving. Five tests assert `pendingTimers === 0` afterwards — see
  "Verification" for proof that assertion bites.
- **Attempt budget = min(attemptTimeout, remaining deadline).** Whichever is
  tighter governs, and the error names the budget actually hit: a
  `TimeoutError` for the attempt timeout, a `DeadlineError` for the total one.
- **Deadline mid-backoff.** A backoff that would outlast the deadline is not
  slept at all — `withRetry` rejects immediately with `DeadlineError`, whose
  `cause` is the last underlying error (`undefined` if no attempt had failed
  yet). It also carries `deadlineMs` and `attempts`.
- **Full jitter** is `rng() * min(maxDelayMs, baseMs * 2 ** (attempt - 1))`.
  `rng` is injected, so the backoff schedule is asserted exactly rather than
  within a tolerance.

### `CircuitBreaker<T>`

Closed to open after N consecutive failures; open rejects fast with
`CircuitOpenError { reason: 'open', retryAfterMs }` without calling the wrapped
function; after the cooldown a single probe is admitted; success closes,
failure re-opens for a fresh cooldown.

The single-probe guarantee — the classic bug — holds because the state
transition and the probe claim both happen in `#admit()`, which runs
**synchronously before the first `await`**. Ten callers arriving in the same
tick produce exactly one call to the wrapped function; the other nine get
`CircuitOpenError { reason: 'probe_in_flight' }`. There is a test that fails
if the claim moves after the await.

The breaker uses **no timers at all** — the cooldown is computed from the clock
when a call arrives — so an idle open breaker holds nothing open.

### Event stream

`ResilienceEvent = RetryEvent | CircuitEvent`, nine variants, every field
`readonly`. `test/events.test.ts` has a `switch` over all nine whose `default`
calls `assertNever(event: never)`.

The exhaustiveness check is proven, not asserted: `type-tests/missing-case.ts`
is the same switch with `circuit.rejected` removed, excluded from the main
build, and a test shells out to `tsc --noEmit` on it and requires a `TS2345`
error mentioning `circuit.rejected`. Add the missing case back and that test
fails — I verified this by doing exactly that (see below).

## How to verify

```
npm install
npm test          # tsc build, then node --test over dist/test
```

`npm run build` alone gives you the tsc gate. Requires Node 22+ (uses
`Promise.withResolvers`); developed on Node 24.18.0, TypeScript 7.0.2.

### tsc output

```
$ npx tsc -p tsconfig.json
tsc exit: 0
```

Zero errors, zero warnings, with `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, plus `noUnusedLocals`, `noUnusedParameters`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, and `verbatimModuleSyntax`.

### Test output (tail)

```
▶ withRetry
  ▶ per-attempt timeout
    ✔ aborts the in-flight attempt via its signal (0.606833ms)
    ✔ rejects even when the attempt ignores the signal (0.284667ms)
    ✔ times out one attempt and lets the next succeed (0.338417ms)
    ✔ clears the attempt timer on success, leaving no pending timers (0.081291ms)
    ✔ clears the attempt timer when the attempt throws synchronously (0.090083ms)
    ✔ clears every attempt timer across a full retry sequence (0.887375ms)
  ✔ per-attempt timeout (2.476666ms)
  ▶ backoff
    ✔ waits the fixed delay between attempts (0.3175ms)
    ✔ applies full jitter over an exponentially growing ceiling (0.267333ms)
    ✔ scales the delay by the injected rng draw (0.239167ms)
    ✔ clamps the exponential ceiling at maxDelayMs (0.418166ms)
  ✔ backoff (1.313416ms)
  ▶ total deadline
    ✔ rejects with DeadlineError carrying the last error as cause (0.326375ms)
    ✔ does not sleep a backoff that would outlast the deadline (0.181041ms)
    ✔ cuts an in-flight attempt short when the deadline is tighter (0.203833ms)
    ✔ reports a DeadlineError with no cause when nothing has failed yet (0.15175ms)
    ✔ succeeds inside the deadline without leaking timers (0.171292ms)
  ✔ total deadline (1.138958ms)
✔ withRetry (10.172417ms)
ℹ tests 41
ℹ suites 7
ℹ pass 41
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 130.517583
```

Test exit code 0. Full suite: 41 tests, 41 passing, ~130ms — no real delays
anywhere, because every test drives `FakeClock`.

### The tests were seen failing

Assertions are only worth what they catch, so I checked each critical one
against a deliberately broken build (mutations applied to a scratch copy; the
source tree here is unmodified):

| Mutation | Result |
| --- | --- |
| Probe claim disabled (all half-open callers probe) | 3 tests fail, incl. "admits exactly ONE probe when many callers arrive at once" |
| Attempt timer never cancelled | 5 tests fail, all four "no leaked timers" assertions among them |
| `DeadlineError` constructed without its `cause` | 1 test fails: "carrying the last underlying error as cause" |
| `circuit.rejected` case restored to the negative fixture | "a non-exhaustive switch fails to compile" fails, as it must |

I also found and fixed a real bug this way. My first `FakeClock.advance` fired
due timers *before* draining the microtask queue, so timers fired for attempts
that had already settled; 11 tests failed. `advance` now flushes microtasks
before each due-timer check, which also means a timer scheduled by an awaited
continuation is picked up within the same `advance`.

### Beyond the fake clock

The suite is entirely deterministic, which leaves one gap: nothing exercised
`systemClock`. I ran a throwaway script against the real clock and confirmed
retry-with-real-backoff, a real per-attempt abort, a real deadline with its
cause, and a real breaker opening — then `process.getActiveResourcesInfo()`
reported `lingering timers: 0` and the process exited 0. That script was
scratch and is not part of the deliverable.

## Constraints

- **No `any`** anywhere in `src/` or `test/`. (`grep -rn '\bany\b' src test`
  matches one prose word in a doc comment.)
- **One `as` cast in the whole project**, in `test/events.test.ts:157`:
  ```ts
  const rogue = { kind: 'unknown.variant' } as unknown as ResilienceEvent;
  ```
  It fabricates a variant the compiler has already proven impossible, to check
  the runtime `assertNever` guard is not silent. `src/` contains zero casts,
  zero non-null assertions, and zero `@ts-ignore`.
- **No timer-based flaky tests.** Every test injects `FakeClock`; wall-clock
  time is never read and nothing sleeps.

## Known limitations

- `CircuitBreaker` counts *consecutive* failures, not a rolling error rate over
  a window. That is what the task asked for and it is the right default for a
  small library, but under low traffic a slow trickle of failures interleaved
  with successes will not trip it.
- One breaker wraps one function. Sharing a breaker across call sites means
  sharing a closure; there is no keyed/multi-tenant registry.
- The half-open probe admits one call and refuses the rest. A more forgiving
  design would queue them behind the probe's outcome. Refusing is the safer
  default — it is what protects a struggling dependency — but callers wanting
  the queued behaviour must build it on top.
- `retryOn` sees only the error, not the attempt number or elapsed time, so
  "retry 429s but only twice" needs a stateful closure.
- `DeadlineError.cause` carries only the *last* error, not every attempt's.
- `withRetry` does not accept a caller-supplied `AbortSignal` for external
  cancellation; each attempt's signal is created internally. The total deadline
  covers the timeout case, but a caller cannot cancel a retry loop on demand.
- Backoff has no `maxDelayMs` for the `fixed` variant because it does not need
  one, and there is no decorrelated-jitter strategy — full jitter is the one
  the task named.
