# Final Judge J1

## T1 — Go worker pool

**Winner: B**  
**Margin: slight**

B gets the central shutdown deadline behavior right: its `Shutdown` cancels `workCtx` and returns `ctx.Err()` as soon as the deadline wins (`B/pool.go:131-145`), whereas A cancels and then unconditionally waits on `p.done` (`A/pool.go:173-178`), so a job that is slow to honor cancellation can make an already-expired shutdown hang indefinitely. B also supplies every requested deliverable and its mutex/condition-channel queue avoids send-versus-close races cleanly. A has the substantially stronger test suite, supports a zero-length rendezvous queue, and tests submit/shutdown races and timeout leak paths that B does not. Because A's defect affects the defining purpose of the shutdown context but B is weaker on edge-case coverage, B wins only slightly; both implementations passed `go test -race ./...` in this review.

## T2 — Go LRU/TTL/singleflight cache

**Winner: B**  
**Margin: slight**

Both implementations are sound on the main algorithms and both passed `go test -race ./...`, but B is the more complete submission: it includes the required `SUMMARY.md` while A does not. B's tests deterministically register waiters through `gateCtx`, cover expired entries not becoming LRU hits, exercise every public cache path from the re-entrant eviction callback, and add a broad mixed race workload (`B/cache_test.go`). Its intrusive list is a little more code than A's `container/list` solution, and B treats any loader error coincident with leader-context cancellation as an abandoned flight (`B/cache.go:191-197`), while A more precisely checks `errors.Is(err, ctx.Err())`. Those caveats keep the margin slight, but B's deliverable completeness and stronger proof of concurrency behavior make it better overall.

## T3 — Rust zero-copy record parser

**Winner: B**  
**Margin: strong**

B supplies the required summary and a notably complete parser package, while A omits `SUMMARY.md`. B's parser validates every record boundary before constructing `Record`, compares declared lengths against remaining bytes in `u64`, uses checked ranges in `read_u16`/`read_u32`, and fuses immediately after an error (`B/src/lib.rs:105-168,245-253`). Its tests include a shared valid/invalid stream builder, 26 named adversarial cases plus exhaustive-prefix, mutation, pseudorandom, and short-input sweeps, maximum field-count coverage, and direct pointer checks proving zero-copy fields. A is also carefully safe and its generated adversarial test is good, but B has more useful error offsets, broader boundary coverage, and all requested deliverables.

## T4 — Rust concurrent token bucket

**Winner: B**  
**Margin: strong**

B's injectable-time design is materially better: `ManualClock` retains weak `Waker`s and wakes blocked limiters whenever test time advances (`B/src/clock.rs:121-178`), so blocking behavior is deterministic through the public clock abstraction. A's injected clock only supplies `now()`; its fairness test must reach into the limiter and call the private condition variable directly (`A/src/lib.rs:406-410`), which means advancing a normal fake clock alone cannot wake an external `acquire` test. B also has a clean FIFO ticket policy, re-anchors on saturation to avoid banked credit, tests lost-wakeup behavior with a 30-waiter handoff, and provides the required summary and a far broader 29-test suite. A is simpler and checks waiter-ID overflow, but it omits `SUMMARY.md` and does not match B's robustness or testability.

## T5 — TypeScript resilience library

**Winner: A**  
**Margin: strong**

A delivers a well-factored implementation, the required summary, and comprehensive deterministic tests, whereas B omits `SUMMARY.md` and has only a small single-file test suite. A's `runAttempt` has one guarded settlement path that cancels the attempt timer on success, rejection, and synchronous throw (`A/src/retry.ts:173-201`), and its breaker claims the half-open probe synchronously before invoking the wrapped function (`A/src/circuit-breaker.ts:87-109`). It thoroughly covers ignored abort signals, deadline-versus-attempt budgets, jitter schedules, fresh cooldown after failed probes, timer cleanup, and ten-way half-open contention. Most decisively, A proves event-union exhaustiveness with both a complete switch and a negative TypeScript fixture that must fail compilation, making its type-level deliverable much stronger than B's positive-only check.

## T6 — Node streaming log pipeline

**Winner: B**  
**Margin: strong**

B provides all deliverables and a clearer end-to-end proof of bounded memory, while A omits `SUMMARY.md`. Its async-generator pipeline naturally propagates output backpressure, explicitly awaits reject-stream drain, and has a direct blocked-sink test showing reject writes cannot buffer without limit (`B/process-logs.mjs:123-159`, `B/test.mjs:170-215`). The seeded fixture writes an independent manifest, places four exact 64 KiB boundary cases, includes a 9 MiB line, and the memory test runs the processor in a fresh child process so fixture generation cannot contaminate the RSS baseline. A's `OutputRouter` is a competent dual-sink design and its growing line buffer avoids repeated concatenation, but its tests are much narrower and its transform accepts object-shaped records with missing/non-string required fields that B correctly rejects.

## T7 — React undoable collaborative store

**Winner: B**  
**Margin: slight**

B is the more restrained and complete deliverable: one compact implementation, one focused test file covering every explicitly required scenario, and the requested `SUMMARY.md`, which A omits. Its hook keeps selector and equality functions in refs while passing a stable subscription and stable `getSelectedSnapshot` callback to `useSyncExternalStore` (`B/src/index.ts:196-243`), directly satisfying the no-resubscribe requirement, and its integer history snapshot makes `useUndoRedo` re-render only when capability bits flip. A has a much broader and generally excellent test suite, stronger transaction rollback behavior, and more exhaustive subscriber/concurrency-adjacent coverage. B's choice to commit a transaction from `finally` even when the callback throws (`B/src/index.ts:171-188`) is a debatable limitation, so its simplicity and deliverable completeness earn only a slight win rather than a strong one.

## T8 — Legacy uploader migration plan

**Winner: A**  
**Margin: slight**

A has the safer migration sequence: first freeze behavior, then add private dependency seams, build a side-by-side typed candidate, keep legacy default-selected behind a stable facade, and roll out through reversible cohorts before flipping the default (`A/PLAN.md:71-153`). B discovers several hazards A misses—notably enumerable prototype methods, calling `Uploader` without `new`, post-response double callbacks driving `running` negative, and UTF-8 corruption across response chunks—so B is stronger in raw archaeology. However, B's Step 0.1 explicitly changes `_resetForTests` to clear module globals despite identifying the current partial reset as a hidden contract, and Step 5 knowingly converts synchronous I/O/scheduling in ways it admits change main-loop interleaving; both conflict with the mandated bug-for-bug migration. A's compatibility shell and dormant full-implementation switch are more realistic ways to use TypeScript and async/await without disguising reliability fixes as migration work, but its missed hazards keep the margin slight.
