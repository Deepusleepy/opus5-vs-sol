# Blind review R2 — `blind/T1..T8`, A vs B

Method: read each spec in `tasks/`, then read both solutions and **ran** them (`go test -race`,
`cargo test`, `tsc` + `node --test`, `npx vitest run`, `node --test`) plus my own adversarial probe
tests written against each side's API. All eight pairs build and their own suites pass; every defect
below is one I reproduced, not one I inferred from reading.

Judged independently per task. No assumption that "A" is one author.

---

## T1 — Go bounded worker pool

**Winner: B — slight**

B recovers a panic thrown by the *error callback* (`pool.go:269`, `defer func() { _ = recover() }()`);
A does not. In A, `report()` is invoked from inside `run`'s deferred closure (`pool.go:212/217`), after
`recover()` has already returned, so a panicking handler propagates out of `run` → `worker` → **process
abort**. My probe (4 jobs, handler panics) killed A's test binary with `exit status 2`; B ran 10/10
follow-up jobs and shut down cleanly. Second, A's `Shutdown(ctx)` deadline is advisory: after
`cancelJob()` it does `<-done` unconditionally (`pool.go:165`), so against a job that ignores its
context, `Shutdown` with a 100 ms deadline never returned within 500 ms in my probe, while B returned
in 101 ms — the spec's "if ctx expires first … returns ctx.Err()" is only honored by A for cooperative
jobs. A is genuinely nicer elsewhere (channel-based queue is simpler than B's slice + waiter-channel +
regenerated `changed` broadcast channel; 11 tests vs B's 8; the leak test exercises four lifecycle
shapes; a real SUMMARY.md, which B omits entirely despite the spec requiring it). Those offsets are
why this is slight and not strong.

## T2 — Go LRU + TTL + singleflight

**Winner: B — strong**

A's cancelled-loader handoff only fires when the loader returns *literally* `ctx.Err()`:
`cache.go:167`, `if err != nil && ctx.Err() != nil && errors.Is(err, ctx.Err())`. Real loaders wrap
(an HTTP client returns `*url.Error`, not `context.Canceled`). I probed both with a loader that
returns `errors.New("upstream: request aborted")` on cancellation: B's waiter drove its own load and
got the value (`loads=2`); A's waiter was handed the dead leader's error (`loads=1`) — exactly the
stranding the spec names, and exactly what A's own doc comment claims cannot happen. B's guard is
`err != nil && ctx.Err() != nil` (`cache.go:193`), which is the robust form. A's fan-in test is also
methodologically weak: `entered <- struct{}{}` is signalled *before* calling `GetOrLoad`
(`cache_test.go:98`), so "loader calls == 1" rests on 100 `runtime.Gosched()` calls, not on proof the
waiters parked. B's `gateCtx` (`cache_test.go:39-52`) closes a channel the instant `GetOrLoad`
consults `ctx.Done()` — i.e. the exact moment a waiter is registered — making the assertion real. B
also ships the required SUMMARY.md (A does not), documents the handoff trade-off honestly, and its
`Config` struct beats A's `WithClock[string,int](...)` two-type-param option functions for ergonomics.

## T3 — Rust zero-copy record parser

**Winner: B — slight**

A reports **every** truncation as `Error::Truncated { at: input.len() }` (`lib.rs:186, 189, 203, 206,
220`) — the end of the input, identical for a header cut, a field-header cut, and a short payload. The
spec asks for "a structured error with byte offset"; B points at the item that could not be completed
(`Truncated { at: start }` / `{ at: pos }` / `{ at: payload_start }`, `lib.rs:140-152`), which is the
offset that actually helps. B's overflow check is also the cleaner one: it compares in `u64`
(`u64::from(declared) > remaining as u64`, `lib.rs:151`) so the check itself cannot wrap on any target
width, and it documents why `LengthOverflow` is unreachable on 32/64-bit. I cross-fuzzed both with
~16k pseudorandom inputs plus every prefix of every `{count, declared_len, pad}` combination over
`{0,1,0x7fffffff,0x80000000,u32::MAX}` — neither panics, so this is not a correctness gap, it is a
diagnostics-quality gap. B additionally ships the required SUMMARY.md (A omits it), a compiling
doctest, a shared `tests/common` builder, and 26 explicitly enumerated adversarial cases satisfying
the "at least 20" clause literally; A's coverage is comparable in substance (its truncation loop and
PRNG sweep generate ~500 cases) but folded into 8 opaque test names.

## T4 — Rust token-bucket rate limiter

**Winner: A — slight**

A's `refill` deliberately does not advance `state.last` when the elapsed time was too small to move
the float (`lib.rs:251-257`), banking the remainder for a later refill. B unconditionally sets
`state.last_refill = now` (`lib.rs:206`), so sub-ULP increments are discarded. I probed B at
capacity 4e9 / rate 1e-4 with 1000×1 ms steps: **0 tokens gained** where ~1e-4 was due; A gains the
expected amount and tests it (`no_drift_over_many_small_steps`). The spec explicitly says "no drift
accumulation", so this is on-spec, though it is a corner reachable only at extreme capacity — at
capacity 1000 / 100 tok/s over 10^6 × 1 µs steps both produce identical results
(`100.00000000219612`). A also has 9 tests to B's 6, including a FIFO-ordering test, and ships the
required SUMMARY.md, which B omits. B is the tidier crate (366 lines vs 516) with a genuinely nice
`duration_until_tokens` that rounds up to a whole nanosecond so conversion cannot shave the deadline
(`lib.rs:219`), and its `VecDeque` waiter queue survived my lost-wakeup probe. A's
`impl std::fmt::Debug for dyn Clock` (`lib.rs:107`) is a wart added solely to make `#[derive(Debug)]`
compile.

## T5 — TypeScript resilience library

**Winner: A — strong**

B uses its own exported `DeadlineError` as an in-band control signal: `runAttempt` rejects with one
when the deadline clips the attempt, and the loop catches `error instanceof DeadlineError` at
`index.ts:199` and immediately gives up. If the wrapped fn rejects with a `DeadlineError` — trivially
possible, it is public API, e.g. a nested `withRetry` — retries stop silently. Probe: 3 max attempts,
`retryOn: () => true`, fn always throws a `DeadlineError` ⇒ **1 call, `retryOn` never consulted, cause
lost**. A discriminates by *which* budget expired rather than by error identity (`retry.ts:99-116`)
and has no such channel. A also carries far stronger evidence of the spec's timer requirement: its
`FakeClock` exposes `pendingTimers` and nearly every one of its 19 tests asserts it returns to 0
(including "a slow attempt that resolves after the timeout does not leak timers"); B asserts
`activeTimers` in 2 of 9. A ships SUMMARY.md; B does not. B's advantage is real but narrower — it
correctly reports a *deadline* rather than a *timeout* when the total budget clips an in-flight
attempt, where A throws `TimeoutError` with the clipped `timeoutMs` (`retry.test.ts:238`). A's five
source files for ~340 lines is a defensible module split, not layering; B's exported `formatEvent`
(`index.ts:300`) is demo code in the public surface.

## T6 — Node backpressure-correct log pipeline

**Winner: A — strong**

B **crashes** on `null`. `JSON.parse("null")` succeeds, then `record.level` at `process-logs.mjs:84`
throws `TypeError: Cannot read properties of null`, destroying the pipeline. I ran it: output file
empty, `.rejects` empty, stack trace on stderr. The spec says malformed lines "go to
`<output>.rejects` with line numbers, **without crashing the pipeline**." Same input on A yields
`{"lines":2,...,"rejected":1}` and `1: null` in the rejects file, because A explicitly guards
`rec === null || typeof rec !== 'object' || Array.isArray(rec)` (`process-logs.mjs:88`). Related: B
passes bare scalars straight through — an input line `42` is written verbatim to the output NDJSON. A
also tests the line splitter harder (dedicated 1-byte-chunk equivalence, CR and LF landing in separate
chunks, multi-byte UTF-8 split byte-by-byte, a 3 MB line across 7919-byte chunks) where B folds one
case into a single test, and A ships the required SUMMARY.md while B does not. B is not without merit:
its fixture computes the chunk-boundary token alignment exactly and *asserts* `tokenEndOffset %
READ_CHUNK === 0` (`make-fixture.mjs:62`), which is stricter than A's approximate padding, and its
structured JSON reject records are nicer than A's `N: raw` lines.

## T7 — React headless undoable store

**Winner: A — strong**

B's render-phase guard latches. Once `isRenderingReactComponent()` fires once, `renderMutationBlocked`
stays `true` until a `queueMicrotask` clears it (`index.ts:82-88`), so a perfectly legal `set()` in the
same microtask turn after a caught render-phase set also throws. Probe: render a component that calls
`set` during render, catch the throw, then call `store.set(5)` from plain test code — B throws
"cannot be called while a React component is rendering"; A returns cleanly with `state: 5`. B's
dispatcher sniff is also brittle in a second way: it keys on `dispatcher.useState?.name !==
"throwInvalidHookError"` (`index.ts:27`), a literal React-internal function name, where A compares two
hook slots for distinct identities plus the async dispatcher `A` (`store.ts:52-62`) — no name
dependency, and documented signal-by-signal. On coverage, A runs 33 tests over 3 files against B's 10,
and A actually *exercises* the tearing claim (`concurrent.test.tsx`: StrictMode double-invocation,
`startTransition` interleaved with a store write, three siblings asserted to agree) where B only
documents it. B does one thing better — the bitmask snapshot in `useUndoRedo` (`index.ts:182`) is
cleaner than A's cached-object comparison — and both ship SUMMARY.md and are `tsc --noEmit` clean.

## T8 — Migration plan for `legacy-uploader.js`

**Winner: A — slight**

B's Step 4 is "build a typed internal core behind a compatibility adapter" as one L-sized change, then
Steps 5-7 flip a switch to it. That is a rewrite behind a flag — aborting mid-Step-4 leaves a half-built
parallel implementation and *no* migration value banked, which contradicts "shipped incrementally
across normal releases (no big-bang)" and "abort mid-migration at any release boundary." B also never
converts the real file to TypeScript; TS exists only inside the candidate. A's sequence (characterization
→ `.d.ts` surface freeze → single import door → dependency seams → *mechanical* TS conversion of the
actual file, diffing emitted JS → one async method per release behind its own flag) banks value at
every boundary, and A says so explicitly ("if the project is cut short, cut it after 4"). On hazard
discovery A is deeper where it counts for a JS→TS migration: its §1.4 catalogues the traps a `class`
conversion silently springs — `constructor === EventEmitter` from the unrestored prototype (line 25),
enumerable prototype methods, `new`-less construction in sloppy mode, `_`-prefixed methods as de facto
test seams, `this` binding for `tokenProvider` — which B's plan barely touches. A also catches the Zalgo
path (a sync `tokenProvider` fires `cb` before `upload()` returns the id), the `out += d` UTF-8
corruption from an unset response encoding, and the `req.on('error')` double-callback driving `running`
negative — plus the sharp move of making the one allowed source edit be fixing `_resetForTests`, without
which no characterization suite is trustworthy. B is genuinely better on release operations (cohort
rollout, soak window, an explicit step to *remove* the fallback, which A lacks) and catches things A
misses (`concurrency || 3` coercing `0`/`NaN`/`''` to 3, reserved metadata keys being overwritten per
chunk, recursion depth in `next()` under a sync test double). B is also tighter — 197 lines vs 297, and
A's 18-item non-goals list does restate §1. Slight, not strong.

---

## Overall pattern

**Tally: A 5 (T4, T5, T6, T7, T8), B 3 (T1, T2, T3).**

The two sides are not stylistically consistent across tasks — T1/T2/T3's B reads like T5/T6/T7's A —
so the honest generalization is about *two recurring modes of work*, not two authors.

**The winning mode, wherever it appears, is characterized by adversarial input modelling.** The
decisive findings all have the same shape: a non-happy-path input the loser never considered. `null`
as a valid-JSON-but-not-an-object log line (T6). A loader that wraps its cancellation error instead of
returning `ctx.Err()` verbatim (T2). An error callback that itself panics (T1). A wrapped function that
throws the library's own error type (T5). A second `set()` in the same microtask as a caught one (T7).
None of these are exotic; all are the second thing you'd try. The winning side in each pair had either
tested that input or structured the code so it could not matter.

**Test methodology separates the pairs more reliably than implementation quality does.** Both sides
always produce green suites, so green is uninformative. What discriminates is whether the tests
*establish* their preconditions or merely hope for them: T2's `gateCtx` proves each waiter is parked
before asserting the loader ran once, versus 100 `runtime.Gosched()` calls and a signal sent before the
call under test. T5's `pendingTimers === 0` asserted in nearly every test versus two. T7's actual
`startTransition` tearing test versus a paragraph asserting tearing-safety in prose. When one side's
suite is 2-3× the other's here, the extra volume was consistently earning its keep against the spec's
own enumerated test list — I found no padded suites in either direction.

**Over-engineering was not a real differentiator, and the losing side was never the more elaborate
one.** The closest calls are A's `impl Debug for dyn Clock` in T4 (a hack to satisfy `derive`), A's
five-file split in T5, B's `formatEvent` demo function in the T5 public API, and B's `let api; … api =
{…}` self-reference in T7. All minor. The specs' "simplicity counts against you" clause did not
meaningfully bite anyone.

**One deliverable was dropped with striking regularity: `SUMMARY.md` is missing from six of the
fourteen code submissions** (T1/B, T2/A, T3/A, T4/B, T5/B, T6/B) despite every spec naming it, and in
five of those six the omitting side also lost the task. It is never the deciding factor on its own —
but it is a reliable marker for the side that treated the spec as a description of the code to write
rather than a checklist to satisfy. Where the margin is "slight" (T1, T3, T4, T8), the missing summary
is doing part of the work of the verdict.

No AI model names appear anywhere in either side's deliverables.
