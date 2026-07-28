# Final judging — blind pairwise review (J2)

All 8 tasks judged independently. Every build/test claim below was executed locally
(go1.26.5, cargo 1.97.1, node v24.18.0, TypeScript 5 for T5, npm-installed deps for T7).

| Task | Winner | Margin |
|---|---|---|
| T1 — Go worker pool | **A** | strong |
| T2 — Go LRU + singleflight | **B** | strong |
| T3 — Rust zero-copy parser | **B** | slight |
| T4 — Rust token bucket | **B** | strong |
| T5 — TS resilience library | **A** | strong |
| T6 — Node log pipeline | **B** | slight |
| T7 — React undoable store | **A** | strong |
| T8 — Migration plan | **B** | slight |

---

## T1 — Go: bounded worker pool → **A**, strong

**B has a real spec violation I confirmed by execution.** The task says shutdown-on-timeout
"cancels in-flight job contexts and returns ctx.Err()"; both solutions' `done` channel is meant
to gate that return. B's `Shutdown` (`T1/B/pool.go:138-145`) selects on `ctx.Done()` and returns
immediately, without waiting for `<-done`. I wrote a probe that submitted a job which sleeps
150ms after its context is cancelled: `Shutdown` returned while the job was still executing.
A's `Shutdown` (`T1/A/pool.go:173-179`) does `p.cancelJob(); <-p.done; return ctx.Err()` — it
cancels, then blocks until every worker has returned. Worse, B's workers have no post-timeout
check: my second probe queued 3 jobs behind a stuck one, timed out the shutdown, and **all 3
queued jobs still ran afterwards** (stats `Submitted:4 Completed:4`). A's worker loop checks
`p.jobCtx.Err() != nil` at `pool.go:195` and abandons the remaining queue, and its
`TestShutdownTimeoutCancelsInFlightJobs` asserts exactly that (`abandoned.Load()` must be false).

B also mis-specs stats: `Completed` is incremented for *every* job including panics and errors
(`pool.go:185`), so `Completed+Failed+Panicked` double-counts — the task asks for four counters
and A's are disjoint and documented. A's `New` accepts `queueSize == 0` (unbuffered, Submit waits
for a free worker) which B rejects with a panic, and A tests that path. The one place A pays for
its channel design is the `senders` WaitGroup dance around closing `p.jobs`
(`pool.go:118-126, 156-161`) — genuinely the trickiest code in either file, but it is correct and
directly stressed by `TestSubmitRacesShutdown` (50 iterations under `-race`). A's SUMMARY also
reports 18 mutation-tested variants, all caught; B's SUMMARY is thin and its output tail
(`ok pool 1.250s`) does not match what I measured, though that is minor. Both pass `-race`
(A 7.97s at `-count=3`, B 1.71s). A is larger (247 vs 220 impl lines, 741 vs 266 test lines) but
the extra tests are earning their keep, not padding.

---

## T2 — Go: LRU + TTL + singleflight → **B**, strong

**A is missing SUMMARY.md entirely** — an explicitly required deliverable ("`SUMMARY.md` as in T1")
— which alone is disqualifying against an otherwise comparable submission. Beyond that, B's
cancellation handoff is genuinely more robust. Both detect leader-cancellation to hand off to
waiters, but A's condition is `err != nil && ctx.Err() != nil && errors.Is(err, ctx.Err())`
(`T2/A/cache.go:167`) — it requires the loader's error to *wrap* `context.Canceled`. B's is
`err != nil && ctx.Err() != nil` (`T2/B/cache.go:193`). I wrote a probe where the cancelled
leader returns its own error type (`errors.New("http: request aborted")` — exactly what a real
HTTP client does) instead of wrapping `ctx.Err()`. On A the waiter with a live context received
the leader's cancellation error; on B the waiter took over and loaded successfully. A's own
handoff test passes only because its fake loader conveniently returns `ctx.Err()` verbatim
(`cache_test.go:191`), i.e. the test is written to the implementation.

B's test suite is materially stronger: 583 vs 252 lines, and it covers things A does not —
`TestExpiredEntryIsNotAnLRUHit` proves an expired read does not save an entry from eviction
(a requirement A never tests), plus `Delete`, a 16-goroutine mixed-workload race test, and a
re-entrant eviction callback that calls back in along *every* public path. A's `gateCtx`
equivalent does not exist; A orders events with `runtime.Gosched()` loops
(`cache_test.go:109-111, 152-154`), which is a sleep in disguise. B's `gateCtx` (`cache_test.go:39-52`)
is a genuinely clever deterministic gate. Both are green at `-race -count=25`. A's `container/list`
is arguably simpler than B's hand-rolled intrusive list, and B's `Config` struct plus `Delete`/
`capacity()` is slightly more surface than asked — but that does not offset a missing deliverable
plus a weaker handoff predicate.

---

## T3 — Rust: zero-copy record parser → **B**, slight

**A is missing SUMMARY.md** — again a required deliverable. On the code itself the two are close
and both are correct: both `#![forbid(unsafe_code)]`, both fuse after error, both avoid wraparound.
B's overflow handling is the cleaner argument: it compares `u64::from(declared) > remaining as u64`
before any conversion (`T3/B/src/lib.rs:151`), so the check itself cannot wrap on any target width,
and it documents that `LengthOverflow` is unreachable on 32/64-bit by construction. A reaches the
same place via `checked_add` + `usize::try_from` (`src/lib.rs:208-217`), which is fine but more
moving parts.

Error offsets are where B is meaningfully better, and I measured it. For a field declaring 100
bytes with 3 present, A reports `Truncated { at: 9 }` (the end of input) and B reports
`Truncated { at: 6 }` (the start of the payload that could not be completed). For a single stray
byte, A says `at: 1`, B says `at: 0`. The task asks for "a structured error with byte offset" and
`Display` "with useful offsets" — B's points at the problem, A's points at where the data ran out,
which is the same number for every error in a given input and therefore much less useful.

Test volume: B has 8 unit + 26 adversarial + 10 integration + 1 doc = 45, against A's 3 unit +
8 integration. The task demands "at least 20 adversarial cases"; A satisfies this only by counting
the loop iterations inside two tests, while B names 26 individually — which matters for
diagnosis when one fails. B's `case23` (every single-byte mutation × 6 byte values) and `case25`
(exhaustive 0..=3-length inputs over an interesting alphabet) are better fuzz coverage than A's
xorshift sweep. A is slightly leaner (265 vs 339 impl lines) and its `Fields` iterator avoids
B's `.expect("validated field header")` (`B/src/lib.rs:230`) — a panic path that is unreachable
but present in a crate whose headline requirement is "must never panic". That is B's one blemish
and it keeps the margin slight rather than strong.

---

## T4 — Rust: concurrent token-bucket → **B**, strong

**A is missing SUMMARY.md.** More substantively, A's injectable clock does not actually make
blocking behavior deterministic, which is the point of the requirement ("Time must be injectable…
so tests are deterministic"). A's `acquire` computes `wait_for` from the deficit and calls
`wait_timeout` with it (`T4/A/src/lib.rs:223-228`) — a *real-time* timeout derived from a *fake*
clock's arithmetic. With an injected clock that never advances, the blocked caller keeps waking on
real time and re-reading the frozen clock: my probe measured **25 wakeups in 300ms**, i.e. a
fixed-interval poll, which is precisely what the task forbids ("no busy-spin, no fixed-interval
polling"). B solves this properly with a `Clock::condvar_timeout` seam (`T4/B/src/clock.rs:28-30`):
`SystemClock` returns the computed wait, `ManualClock` returns `None` so waiters park indefinitely
and are released by a `Waker` when the test advances time (`clock.rs:167-179`). The `Waker` takes
the limiter's state lock before notifying (`clock.rs:64-69`) to close the lost-wakeup window, and
`ManualClock::advance` deliberately clones wakers out before releasing its own lock to avoid lock
inversion (`clock.rs:150-157`) — both hazards are identified in comments and are real.

Test coverage is not close: B has 29 unit + 2 doc tests versus A's 8. A's fairness test
(`lib.rs:381-419`) reaches into `limiter.inner.changed.notify_all()` from the test to make progress
— it is testing a hand-driven internal, not the public contract. B's
`a_large_waiter_is_not_starved_by_a_stream_of_small_acquires` puts a 4-token waiter ahead of 20
1-token waiters and asserts the big one goes first with none slipping through, then drains the
followers in order (`src/tests.rs:377-418`); its `concurrent_acquire_storm_conserves_tokens` does
an exact token-conservation budget across 40 threads (`tests.rs:508-548`). Both share the same
sound anchor-pair refill math (compute from anchor, never accumulate) and both re-anchor at
capacity to discard overflow. B is bigger (1162 vs 446 lines) but the split into `clock.rs` is
justified by the seam it buys, not decoration.

---

## T5 — TypeScript: typed resilience library → **A**, strong

**B does not compile clean, and B is missing SUMMARY.md.** Running `tsc --noEmit` against B with
`@types/node` unavailable in its own tree surfaced `test/resilience.test.ts(230,18): error TS18046:
'error' is of type 'unknown'` — a genuine strictness error independent of module resolution, in a
task whose deliverable is explicitly "zero tsc errors". (With node types present, B does build and
its 10 tests pass; A builds clean and its 41 tests pass.)

The decisive functional gap is the half-open probe. The task calls out "concurrent calls during
half-open must NOT all probe (this is the classic bug)". A tracks an explicit `#probeInFlight` flag
(`T5/A/src/circuit-breaker.ts:40, 102-108`) that is claimed synchronously before `fn` is invoked and
released in `#onSuccess`/`#onFailure`, and rejects the second concurrent caller with a distinct
`probe_in_flight` reason. B relies on the state still being `"half-open"` (`T5/B/src/index.ts:381-383`),
which happens to work only because B never resets state during the probe — the guarantee is
incidental rather than structural, and B's `#recordSuccess(probe)`/`#recordFailure(probe)` carry a
`probe` boolean that duplicates what the flag would have made explicit.

Exhaustiveness is the other clear split. The task wants it "proven by a compile-time exhaustiveness
check". B writes `const exhaustive: never = event` inside a test (`test/resilience.test.ts:122`) —
which proves nothing at runtime and is never verified to fail. A ships a dedicated negative fixture
(`type-tests/missing-case.ts`) with one case deliberately removed, and a test that shells out to
`tsc -p type-tests/tsconfig.json` and asserts it fails with `TS2345` naming `circuit.rejected`
(`test/events.test.ts:161-190`) — I ran it; it passes in ~200ms. That is a gate that has been seen
failing. A's tsconfig also enables `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch`, and `verbatimModuleSyntax` beyond the three required flags. A is
larger (531 src+test lines vs 439+434) but modularly so, and its 41 tests versus 10 cover
deadline-mid-backoff, timer-leak assertions, and per-attempt-vs-deadline budget interaction that
B only partly reaches.

---

## T6 — Node.js: backpressure-correct log pipeline → **B**, slight

**A is missing SUMMARY.md**, which the task requires with output tails. Both pipelines are
genuinely backpressure-correct and both pass their RSS budget on a 50MB fixture — I ran both:
A peaked at +115.7MB, B at +97.9MB, budget 150MB. B measures more honestly: it runs the pipeline in
a **fresh child process** (`test.mjs:255-270`) so baseline RSS is a bare interpreter uncontaminated
by fixture generation, whereas A samples in-process after having just generated the fixture.

Test breadth is the main separator: B has 13 tests to A's 2. The task asks for "a unit test of the
line-splitting transform with pathological chunkings (1-byte chunks)"; A has one such test, B has
six splitter tests including one that asserts *identical output across every chunking* including
1-byte, bare-CR handling, a line far larger than one chunk, and boundaries exactly at/before/after
a newline. B also has a dedicated test that `backpressuredWrite` returns a pending promise and does
not resolve until the sink drains (`test.mjs:190-214`) — it proves the backpressure claim rather
than asserting RSS and hoping. B additionally tests empty input, ENOENT, and fixture determinism
across seeds.

Where A is better: its reject behavior is closer to spec. The task says "**malformed JSON** lines
go to `<output>.rejects`". I fed both a line of valid JSON missing `msg`: A passes it through
(correct — it is not malformed JSON), B rejects it with `missing or non-string "level"/"msg"`
(`process-logs.mjs:97-101`) — B is silently dropping well-formed records the spec says to keep.
That is a real spec deviation and it is why the margin is slight, not strong. A's fixture is also
cleverer in one respect: it computes filler so a Bearer token ends exactly on a 64KiB read boundary
and *asserts* the alignment (`make-fixture.mjs`, "failed to align boundary token"), directly
covering the edge the task calls out. B's manifest asserts `onChunkBoundary` for 4 cases similarly.
B's richer `reason` field in rejects and its stats reporting are small wins. On balance B's far
stronger gauntlet plus the present SUMMARY outweighs A's better reject predicate.

---

## T7 — React: undoable collaborative store → **A**, strong

**I found and reproduced a real bug in B.** B's render guard sets a `replayingFailedRender` latch
that stays true until a `queueMicrotask` clears it (`T7/B/src/index.ts:78-88`). I wrote a test that
renders a component doing a render-phase `set`, catches the thrown error synchronously, and then
performs a **legitimate** `set` outside render in the same turn — B throws
"Undoable store state cannot be changed during React render" on the legitimate call and the store
stays at 0. A passes the identical test (store correctly reaches 100). B's latch converts a
correct call into a spurious error for a whole microtask window; A's guard
(`T7/A/src/render-guard.ts:52-62`) uses a `sawDispatcher` flag that only affects the
dispatcher-is-null case, so it handles the same dev-replay scenario without poisoning valid calls.

B also targets the wrong React internal. It reads
`__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED` with `ReactCurrentDispatcher`/`ReactCurrentOwner`
(`src/index.ts:36-44`) — the React 17/18 shape. A reads
`__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H`
(`render-guard.ts:35-39`), the React 19 shape, matching the React 19 it declares. B pins React 18,
so it is internally consistent, but A explicitly documents the fail-open design ("if a future React
renames the field we report 'not rendering' and lose the warning rather than throwing on correct
code") — and B's bug is precisely the failure mode A designed against.

Test coverage is 77 tests across 7 files versus 10 in one file. A tests things the task names that
B does not: nested-transaction rollback on throw, `undo`/`redo` rejected inside `transact`,
external subscriber ordering under mid-pass unsubscribe, `startTransition`/concurrent-feature
consistency (`tests/concurrent.test.tsx`), the history cap counting a transaction as one entry, and
a store whose value type includes `undefined`. Both pass `tsc --noEmit` clean and both `vitest run`
green; I verified selector-identity stability and the no-infinite-loop behavior for inline
fresh-object selectors on both (both fine, 1 render on mount, 2 after an unrelated set). A's
`useStoreSlice` extraction into its own file (`src/use-store-slice.ts`) is the one place it adds a
layer B does not, and it is justified — it is where the `useSyncExternalStore` caching contract and
the tearing-safety rationale are documented.

---

## T8 — Planning only: migration plan → **B**, slight

Both plans are strong and both show real restraint. B wins on hazard discovery depth — it finds
several load-bearing quirks A misses entirely. B identifies the **double-callback** at
`req.on('error', cb)` remaining attached after response completion (line 120 + 113-117), traces it
to `done()` running twice → `this.running` going **negative** → silently inflated concurrency, and
then draws the migration-critical conclusion: naively promisifying `_send` makes it settle-once and
*silently fixes* this, which is an unagreed behavior change (§1.2). That is exactly the class of
insight this task rewards. B also catches the **Zalgo** hazard (§1.3): with a synchronous injected
`tokenProvider`, `_drain()` running synchronously from `upload()` means the error callback fires
*before* `upload()` returns the id — and notes async/await removes this, a real if perverse
behavior change. And B catches **UTF-8 corruption** from `out += d` with no `res.setEncoding`
(lines 110-112), which A does not mention. B's §1.4 on class-conversion hazards is the sharpest
section in either document: `constructor === EventEmitter`, prototype method enumerability, sloppy-mode
`Uploader(opts)` without `new`, and `_`-prefixed methods as de facto test seams — with the correct
conclusion to **not** convert to `class`.

B's sequencing is also more realistic. Its Step 0.1 — the single allowed source edit, extending
`_resetForTests` to also reset `uploadCounter`, `globalRetryDelay`, and clear `activeUploads`
*in place* — correctly identifies that no characterization suite can be trusted until test-order
state leaks are fixed, and ships it alone because production never calls it. Its Step 2
"single import door" (codemod 40 call sites to one re-export) is the pragmatic move that makes
every later swap a one-line change and every later revert a one-line revert; A has no equivalent
and its steps are correspondingly harder to revert independently. B's Step 5 decomposition
(`_readToken` → `_send` → `_sendChunked` → `_drain`/`upload`, bottom-up, each flagged) with the
explicit note to ship the low-traffic chunked path before the high-traffic pump is better ordered
than A's monolithic "Step 4: side-by-side typed candidate — L".

A's advantages are real but narrower: it is more concise (197 vs 297 lines, and the task says
"concise beats long"), its findings tables with per-line "why it constrains migration" columns are
easier to scan, and its differential-trace compatibility proof (byte-for-byte equal ordered traces
after normalizing timestamps/random) is a more rigorous single proof technique than B's per-step
mix. A also correctly flags the `cwd`-at-construction vs `cwd`-at-token-read split, which B also
catches. But A misses the double-callback, Zalgo, and UTF-8 hazards, and its non-goals list, while
long, is a flat prose dump against B's numbered 18-item list with a **P0/P1/P2/P3-prioritized**
follow-up ticket set. B's closing judgement — "if the project is cut short, cut it after 4" — is the
kind of concrete abort guidance the task asked for. Margin is slight because A's concision is
genuinely on-spec and B's length is close to the padding line.

---

## Cross-cutting observations

- **Deliverable completeness split sharply by label.** The A-labelled solution omitted the required
  `SUMMARY.md` in **five** of eight tasks (T2, T3, T4, T5, T6); the B-labelled solution omitted it in
  one (T1 has it; T5/B lacks it). This was decisive or contributory in T2, T3, T4, and T6.
- **Tests written to the implementation.** Two cases where a passing test proved less than it
  appeared: T2/A's handoff test uses a loader that returns `ctx.Err()` verbatim, hiding the
  `errors.Is` narrowness; T5/B's "exhaustiveness check" is a `never` assignment never verified to
  fail. T5/A's negative `tsc` fixture and T1/A's 18-mutation report are the counterexamples — both
  are gates that have been seen failing.
- **Injectable clocks that are not actually injectable.** T4/A and T5/B both accept a clock but
  still derive real-time waits from it. T4/B's `condvar_timeout` seam and T5/A's `setTimer`
  abstraction are the correct shape.
- **Bugs found by writing new probes, not by reading.** The three most consequential findings —
  T1/B's early `Shutdown` return plus queued jobs running past the deadline, T7/B's guard poisoning
  legitimate post-error `set` calls, T2/A's narrow cancellation predicate — were all invisible in
  the passing suites and only surfaced under adversarial tests I wrote against the stated
  requirements.
