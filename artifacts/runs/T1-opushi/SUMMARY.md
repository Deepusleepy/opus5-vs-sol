# T1 — Bounded worker pool with graceful shutdown

Go package `pool`, standard library only. Module `pool`, Go 1.22+ (developed and
verified on go1.26.5 darwin/arm64).

## What I built

`pool.go` (~200 lines including docs) exposes:

- `New(workers, queueSize int) *Pool` — starts `workers` goroutines reading a
  buffered channel of capacity `queueSize`. Panics on `workers < 1` or
  `queueSize < 0`; those are programmer errors, not runtime conditions.
- `Submit(ctx, job) error` — sends to the queue channel, so it blocks naturally
  once `workers + queueSize` jobs are outstanding. A three-way `select` returns
  `ctx.Err()` if the caller's context is cancelled while blocked, and
  `ErrClosed` if shutdown starts while blocked.
- `Shutdown(ctx) error` — flips `closed`, closes the `closing` channel to wake
  blocked `Submit`s, then closes the job channel so workers drain and exit.
  Returns `nil` once every worker has returned; if `ctx` expires first it
  cancels the job context, waits for workers anyway, and returns `ctx.Err()`.
- `SetErrorHandler(func(error))` — receives every job error, and job panics
  wrapped as `*PanicError{Value, Stack}`.
- `Stats() Stats` — mutex-guarded snapshot of `Submitted / Completed / Failed /
  Panicked`.

### Design decisions worth flagging

**Two contexts, deliberately.** The context a job receives is pool-owned, not
the one passed to `Submit`. `Submit`'s context governs *admission* only — a
caller giving up on enqueueing shouldn't cancel a job the pool already accepted
and possibly already started. The pool's context is cancelled only when
`Shutdown` times out, which is exactly what "cancel in-flight jobs" means here.

**Closing the job channel safely.** The only correct way to make N workers drain
a bounded queue and then exit is to close the channel they range over — but
closing a channel a concurrent `Submit` might send on panics. So `Submit`
registers on a `senders` WaitGroup under a read lock after checking `closed`
under that same lock, and `Shutdown` closes the channel from a goroutine that
first waits for `senders`. The `closing` channel guarantees registered senders
drain promptly rather than blocking that wait. This is the one piece of the file
that needs care, so it is tested directly (`TestSubmitRacesShutdown`, 50
iterations under `-race`).

**Panic reporting happens after recovery.** The job runs inside an inner
function whose `defer` captures the panic; counting and the error-handler call
happen on the normal path afterwards. The handler call is itself wrapped in a
`recover`, so a buggy handler cannot take a worker down.

**Stats accounting.** `Submitted` is incremented only on a successful enqueue,
and each job that *runs* lands in exactly one of the other three counters.
`Submitted` can exceed their sum: jobs still queued when `Shutdown`'s context
expires are abandoned by design. This is documented on the `Stats` type.

## How to verify

```
cd <this directory>
gofmt -l . && go vet ./...
go test -race ./...
```

Tail of `go test -race -v ./...`:

```
=== RUN   TestSubmitRunsJobs
--- PASS: TestSubmitRunsJobs (0.00s)
=== RUN   TestSubmitCancelledWhileQueueFull
--- PASS: TestSubmitCancelledWhileQueueFull (0.05s)
=== RUN   TestSubmitWithAlreadyCancelledContext
--- PASS: TestSubmitWithAlreadyCancelledContext (0.00s)
=== RUN   TestShutdownDrainsQueuedJobs
--- PASS: TestShutdownDrainsQueuedJobs (0.02s)
=== RUN   TestShutdownTimeoutCancelsInFlightJobs
--- PASS: TestShutdownTimeoutCancelsInFlightJobs (0.05s)
=== RUN   TestShutdownUnblocksBlockedSubmit
--- PASS: TestShutdownUnblocksBlockedSubmit (0.05s)
=== RUN   TestDoubleShutdown
--- PASS: TestDoubleShutdown (0.00s)
=== RUN   TestShutdownWithExpiredContextAfterDrain
--- PASS: TestShutdownWithExpiredContextAfterDrain (0.00s)
=== RUN   TestConcurrentShutdown
--- PASS: TestConcurrentShutdown (0.00s)
=== RUN   TestSubmitAfterShutdown
--- PASS: TestSubmitAfterShutdown (0.00s)
=== RUN   TestPanicRecovery
--- PASS: TestPanicRecovery (0.00s)
=== RUN   TestPanickingErrorHandlerDoesNotKillWorker
--- PASS: TestPanickingErrorHandlerDoesNotKillWorker (0.00s)
=== RUN   TestErrorsAreReported
--- PASS: TestErrorsAreReported (0.00s)
=== RUN   TestNoErrorHandlerIsSafe
--- PASS: TestNoErrorHandlerIsSafe (0.00s)
=== RUN   TestQueueIsBounded
--- PASS: TestQueueIsBounded (1.10s)
=== RUN   TestStatsUnderConcurrency
--- PASS: TestStatsUnderConcurrency (0.00s)
=== RUN   TestSubmitRacesShutdown
--- PASS: TestSubmitRacesShutdown (0.00s)
=== RUN   TestNoGoroutineLeak
--- PASS: TestNoGoroutineLeak (0.85s)
PASS
ok  	pool	3.334s
```

Also run clean: `go test -race -count=3 ./...` (`ok pool 7.890s`), and
`-count=10` restricted to the concurrency tests (`ok pool 11.187s`).
`gofmt -l` and `go vet` report nothing. Statement coverage is 97.6% — the
uncovered statements are the two `New` argument-validation panics.

### Every required scenario is covered

| Requirement | Test |
| --- | --- |
| cancellation while blocked on a full queue | `TestSubmitCancelledWhileQueueFull` |
| shutdown draining | `TestShutdownDrainsQueuedJobs` |
| shutdown timeout cancels in-flight jobs | `TestShutdownTimeoutCancelsInFlightJobs` |
| double shutdown | `TestDoubleShutdown`, `TestConcurrentShutdown` |
| submit after shutdown | `TestSubmitAfterShutdown` |
| panic recovery | `TestPanicRecovery` |
| goroutine-leak check | `TestNoGoroutineLeak` |

The leak check is stricter than a single before/after comparison: it runs 20
rounds of four different exit paths (graceful drain, panicking job, shutdown
timeout with abandoned queue and a blocked `Submit`, and a `Submit` cancelled
while waiting), establishes the baseline by polling until the count is stable,
then polls the count back down to `baseline + 2` within 5s, dumping all
goroutine stacks on failure.

### The tests were checked against mutated implementations

Passing tests only prove something if they can fail. I ran 18 mutations of
`pool.go` in a scratch copy outside this directory — dropping the `ctx.Done()`
arm from `Submit`, not cancelling jobs on shutdown timeout, disabling the
`recover`, closing the job channel without waiting for senders, making
`Shutdown` non-idempotent, letting workers run abandoned queue entries after a
timeout, accepting submits post-shutdown, stopping workers instead of draining,
leaking a goroutine per pool, reading `Stats` without the lock, and five
mis-accounting / wrong-context variants. **All 18 were caught**, each by the
test that should catch it. One test bug surfaced during this work
(`TestStatsUnderConcurrency` was calling `Shutdown` before its submitters
finished, so the counts raced); it was fixed in the test, not by weakening the
implementation.

## Known limitations

- **No result plumbing.** Jobs return `error`; there is no per-job handle,
  future, or result channel. Callers that need a value close over one. Not
  asked for, so not built.
- **Error handler runs on the worker goroutine.** A slow handler slows that
  worker. Documented; buffering it would be an unrequested design choice.
- **`SetErrorHandler` while jobs are running** is race-free but not ordered —
  a job already past the report point uses the old handler. It is meant to be
  set once at construction. A handler must not call `SetErrorHandler` itself
  (self-deadlock on the mutex); documented.
- **`Submitted` is not the sum of the outcome counters** when a shutdown times
  out with work still queued. Documented on the type; there is no `Abandoned`
  counter because nothing asked for one.
- **No unbounded/resizable mode, no priorities, no retries, no per-job
  timeouts.** Worker count and queue size are fixed at `New`.
- The leak check's `baseline + 2` tolerance is empirical. It is tight enough
  that a one-goroutine-per-pool leak over 20 rounds fails loudly (verified by
  mutation M9), but it is a heuristic rather than a proof.
