# T5 — Typed resilience library (retry + circuit breaker)

## What I built

A small, dependency-free resilience library in strict TypeScript for Node. ~350 lines of
source across six files, plus ~650 lines of tests.

### `src/clock.ts`
`Clock` is the single time abstraction: `now()` and `setTimer(delayMs, cb) => CancelTimer`.
Every timing decision in the library goes through it, so no test depends on wall-clock time.
`systemClock` is the production implementation; `sleep()` is a clock-backed, abortable delay.

### `src/retry.ts` — `withRetry<T>(fn, policy)`
`fn: (attempt: number, signal: AbortSignal) => Promise<T>`. Policy:

- `maxAttempts` (includes the first attempt)
- `backoff`: `{ kind: 'fixed', delayMs }` or
  `{ kind: 'exponential', baseMs, maxDelayMs }` with **full jitter**:
  `delay = rng() * min(maxDelayMs, baseMs * 2^(attempt-1))`
- `attemptTimeoutMs` — aborts the in-flight attempt through the `AbortSignal`
- `totalDeadlineMs` — wall-clock budget for the entire call
- `retryOn(error)` — `false` rethrows immediately
- injectable `rng`, `clock`, `onEvent`

Notable behaviors:

- **Timer cleanup.** The attempt-timeout timer is armed in `runAttempt` and cancelled in a
  `finally`, so it is released on success, on failure, and on timeout alike. The tests assert
  `fakeClock.pendingTimers === 0` after every terminal path — a leaked timer is a hard test
  failure, not a "process hangs sometimes" symptom.
- **Deadline clipping.** The effective per-attempt timeout is
  `min(attemptTimeoutMs, deadlineAt - now)`, so an attempt cannot run past the total deadline.
- **Deadline during backoff.** If `now + delay >= deadlineAt`, the call rejects with
  `DeadlineError` whose `cause` is the last underlying error — it does not sleep past the
  deadline and then discover it.
- The losing side of the `Promise.race` gets a no-op `.catch()`, so a slow attempt that settles
  after its timeout cannot produce an unhandled rejection.

### `src/circuit.ts` — `CircuitBreaker<T>`
`closed` → `open` after `failureThreshold` consecutive failures. `open` rejects immediately
with `CircuitOpenError` without touching the wrapped fn. After `cooldownMs`, the next
observation moves it to `half-open`.

**The half-open concurrency bug is explicitly handled.** A `#probeInFlight` flag is set
synchronously, before the `await`, by whichever caller arrives first. Every other concurrent
caller during half-open is rejected with `CircuitOpenError('half-open')`. The test fires ten
simultaneous `exec()` calls against a half-open breaker whose wrapped fn parks forever, and
asserts: exactly 9 rejections, exactly 1 still pending, and `gate.calls === 2` (one to trip,
one probe). A naive implementation that only checks state would call the fn ten times.

A successful probe closes the circuit and resets the counter; a failed probe re-opens it and
restarts the cooldown from the failure (asserted in `a failed probe re-opens the circuit`).

### `src/events.ts` — discriminated-union event stream
`ResilienceEvent = RetryEvent | CircuitEvent`, eight variants total, all with a literal `type`
discriminant. `onEvent` on both the retry policy and the breaker options accepts the union.

Exhaustiveness is proven, not asserted by convention: `describeEvent` in
`test/events.test.ts` switches over all eight variants and calls `assertNever(e)` in the
default branch. I verified this is load-bearing by temporarily adding a ninth variant to the
union and rebuilding:

```
test/events.test.ts(34,26): error TS2345: Argument of type
'{ readonly type: "circuit-new-variant"; readonly at: number; }'
is not assignable to parameter of type 'never'.
```

The variant was then removed and the build returned to clean.

## How to verify

```
npm install     # typescript + @types/node only
npm run build   # tsc -p tsconfig.json
npm test        # build, then node --test 'dist/test/*.test.js'
```

tsconfig uses `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`, plus
`noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
and `verbatimModuleSyntax`.

### tsc output

```
$ rm -rf dist && npx tsc -p tsconfig.json
tsc exit=0
```

Zero diagnostics — `tsc` prints nothing on success.

### test output tail

```
$ node --test 'dist/test/*.test.js'
✔ opens after N consecutive failures and then rejects fast (1.126333ms)
✔ a success resets the consecutive-failure counter (0.155209ms)
✔ stays open until the cooldown elapses, then goes half-open (0.571083ms)
✔ half-open admits exactly ONE probe under concurrency (1.074084ms)
✔ a successful probe closes the circuit (0.164041ms)
✔ a failed probe re-opens the circuit and restarts the cooldown (0.134250ms)
✔ the exhaustive switch handles every variant the library emits (1.688750ms)
✔ assertNever throws when a bad value reaches it at runtime (0.158542ms)
✔ giveup reasons are covered by the exhaustive handler (0.623167ms)
✔ succeeds on the first attempt without arming or leaking timers (1.270375ms)
✔ retries with fixed backoff and cleans up every attempt timer (0.408666ms)
✔ per-attempt timeout aborts the in-flight attempt via the signal (0.966000ms)
✔ exponential backoff with full jitter uses the injected RNG and caps at maxDelayMs (0.090250ms)
✔ exponential backoff drives the actual sleep durations (0.214250ms)
✔ retryOn=false rethrows immediately without further attempts (0.131042ms)
✔ exhausting maxAttempts rethrows the last error (0.218209ms)
✔ total deadline expiring mid-backoff rejects with DeadlineError carrying the last error as cause (0.207084ms)
✔ the remaining deadline clips the per-attempt timeout (0.258208ms)
✔ a slow attempt that resolves after the timeout does not leak timers or unhandled rejections (0.158875ms)
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 72.802041
```

Total runtime is ~70ms because no test waits on a real timer — `test/fake-clock.ts` advances
a virtual clock and drains microtasks between each fired timer.

## Constraint compliance

- **No `any`** anywhere in `src/` or `test/`. Error values are typed `unknown` and narrowed
  with `instanceof`.
- **One cast**, in test code only: `test/events.test.ts:84`,
  `{ type: 'nope' } as unknown as never`. It exists solely to exercise the runtime throw
  inside `assertNever`, which is by construction unreachable from well-typed code. There are
  no casts in `src/`. (`as const` on a literal backoff object in `retry.test.ts:109` is a
  const assertion, not a type assertion.)
- **No timer-based flaky tests.** All 19 tests drive `FakeClock`; nothing calls the real
  `setTimeout`. Assertions on `pendingTimers` are what prove there are no leaked handles.

## Known limitations

- `Clock.now()` uses `Date.now()` in the system implementation, so backoff and cooldown math
  is sensitive to wall-clock jumps. Swapping in `performance.now()` is a one-line change in
  `systemClock` but would make the numbers non-comparable across processes, so I left the
  simpler choice.
- `withRetry` passes an `AbortSignal` to `fn` but has no caller-supplied signal to compose
  with — a caller that wants external cancellation must handle it inside `fn`. Nothing in the
  requirements asked for it and adding a second signal source is real complexity.
- The breaker counts *consecutive* failures only; there is no rolling-window or error-rate
  mode, as specified.
- `CircuitBreaker` transitions to half-open lazily, when `exec()` or `state` is next
  consulted, rather than from a scheduled timer. Behaviorally equivalent for any caller and it
  means an idle breaker holds no timers.
- The breaker rejects excess half-open callers rather than queuing them behind the probe.
  Rejecting fast is the standard behavior — queuing would reintroduce the pile-up the breaker
  exists to prevent.
