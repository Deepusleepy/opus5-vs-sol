# `pool` — bounded worker pool with graceful shutdown

Standard-library-only Go package implementing a fixed-size worker pool over a bounded queue.

## Files

- `go.mod` — module `pool`
- `pool.go` — implementation
- `pool_test.go` — tests

## API

```go
func New(workers, queueSize int) *Pool
func (p *Pool) Submit(ctx context.Context, job Job) error   // Job = func(context.Context) error
func (p *Pool) Shutdown(ctx context.Context) error
func (p *Pool) Stats() Stats
func (p *Pool) OnError(fn func(error))

var ErrClosed = errors.New("pool: closed")
type PanicError struct { Value any; Stack []byte }
type Stats struct { Submitted, Completed, Failed, Panicked uint64 }
```

## Design notes

**Submit.** Blocks on `p.jobs <- job` in a `select` that also watches `ctx.Done()` and the
pool's `closing` channel, so a blocked caller unblocks on either cancellation (`ctx.Err()`)
or shutdown (`ErrClosed`). An already-expired ctx is checked up front so a free queue slot
cannot win that race.

**Send-after-close safety.** Closing the job channel is what tells workers to drain and exit,
but closing it while a `Submit` is mid-send would panic. A `sync.RWMutex` plus a `sync.WaitGroup`
of in-flight senders solves this: `Submit` takes the read lock only to check `closing` and
register itself (never while blocked); `Shutdown` takes the write lock, closes `closing`, then
waits for registered senders. Since closing `closing` forces every blocked send to return, that
wait is bounded and no send can outlive the close.

**Shutdown.** Idempotent via `sync.Once`; concurrent and repeated calls all wait for workers to
exit. On the happy path, workers drain the closed channel and return. If the caller's ctx expires
first, `cancelJob` cancels the single context handed to all running jobs, workers stop pulling
new work, and `ctx.Err()` is returned — but only after workers have actually exited, so Shutdown
never returns while goroutines are still live. Workers re-check the cancelled context before each
`select` so a cancelled pool never starts an already-queued job (a single combined `select` would
pick at random).

**Panics.** Each job runs under a `defer`/`recover` that increments `Panicked` and `Failed` and
reports a `*PanicError` (with stack) to the error callback. The worker loop continues.

**Stats.** Four `atomic.Uint64` counters; `Stats()` is a lock-free snapshot (not an atomic
snapshot across all four — see limitations).

**Goroutines.** Exactly `workers` long-lived goroutines, plus one short-lived waiter per
`Shutdown` call that always terminates because it only waits on `p.wg`.

## How to verify

```
cd <this directory>
go vet ./...
go test -race ./...
```

Tests cover: normal submit/run, cancellation while blocked on a full queue, already-expired
submit context, shutdown draining, shutdown timeout cancelling in-flight jobs and discarding
queued ones, double and concurrent shutdown, submit-after-shutdown, blocked-submit-unblocks-on-
shutdown, panic recovery (workers survive, callback receives `*PanicError`, stats correct),
`Stats()` read concurrently with submits, and a goroutine-leak check.

The leak test runs 20 iterations of four pool lifecycles each (clean drain, all-panicking jobs,
shutdown-deadline expiry with a blocked worker and a blocked submit, and a submit cancelled on a
full queue), then compares `runtime.NumGoroutine()` against the pre-test baseline with a
tolerance of +2 and a settle window.

### `go test -race ./...` output tail

```
=== RUN   TestSubmitAndRun
--- PASS: TestSubmitAndRun (0.00s)
=== RUN   TestSubmitCancelledWhileQueueFull
--- PASS: TestSubmitCancelledWhileQueueFull (0.05s)
=== RUN   TestSubmitExpiredContext
--- PASS: TestSubmitExpiredContext (0.00s)
=== RUN   TestShutdownDrainsQueue
--- PASS: TestShutdownDrainsQueue (0.00s)
=== RUN   TestShutdownTimeoutCancelsInFlight
--- PASS: TestShutdownTimeoutCancelsInFlight (0.05s)
=== RUN   TestDoubleShutdown
--- PASS: TestDoubleShutdown (0.00s)
=== RUN   TestSubmitAfterShutdown
--- PASS: TestSubmitAfterShutdown (0.00s)
=== RUN   TestBlockedSubmitUnblocksOnShutdown
--- PASS: TestBlockedSubmitUnblocksOnShutdown (0.05s)
=== RUN   TestPanicRecovery
--- PASS: TestPanicRecovery (0.00s)
=== RUN   TestStatsConcurrentWithSubmit
--- PASS: TestStatsConcurrentWithSubmit (0.00s)
=== RUN   TestNoGoroutineLeak
--- PASS: TestNoGoroutineLeak (0.65s)
PASS
ok  	pool	1.978s
```

Also verified clean under `go vet ./...`, `gofmt -l .`, and `go test -race -count=3 ./...`.

## Known limitations

- **Stats is not a consistent snapshot.** The four counters are read independently, so a
  concurrent job can be counted in one field and not yet in another. Per-field values are
  always monotonic and accurate; only the cross-field sum may lag by in-flight jobs.
- **Jobs share one context.** All jobs receive the same pool-level context, which carries no
  values and no deadline until Shutdown's deadline expires. Per-job deadlines are the caller's
  responsibility (wrap inside the job body). The submitting context is deliberately *not*
  propagated into execution: a queued job would otherwise die when its submitter returned.
- **Shutdown timeout does not interrupt uncooperative jobs.** A job that ignores its context
  keeps running; Shutdown returns `ctx.Err()` only after it finishes, because returning earlier
  would mean returning while goroutines are still live. This is a deliberate trade — Go cannot
  kill a goroutine — but it means a wedged job blocks Shutdown indefinitely.
- **`OnError` is called synchronously on the worker goroutine**, so a slow callback slows that
  worker. Callbacks must be non-blocking and concurrency-safe.
- **No restart.** A pool is single-use; after Shutdown it cannot be reopened.
- `workers < 1` is clamped to 1 and `queueSize < 0` to 0 rather than returning an error, keeping
  `New` non-failing.
