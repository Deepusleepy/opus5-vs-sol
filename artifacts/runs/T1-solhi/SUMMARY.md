# Worker pool summary

## What was built

- A fixed-size worker pool with a bounded FIFO queue.
- Context-aware submission that blocks at queue capacity and returns the submission context error if canceled while waiting.
- Graceful, idempotent shutdown that closes admission immediately, drains accepted work, and waits for workers.
- Shutdown timeout handling that cancels the context shared by executing and subsequently drained jobs.
- Panic recovery with stack-bearing errors delivered through `SetErrorHandler` without losing the worker.
- A concurrency-safe `Stats` snapshot containing submitted, completed, failed, and panicked counts.
- Tests for blocked submission cancellation, queue draining, shutdown timeout cancellation, sequential and concurrent shutdown, submission after shutdown, panic recovery, error reporting, statistics, invalid construction, and goroutine cleanup.

`Completed` counts every job invocation that finishes, including returned errors and recovered panics. `Failed` counts non-nil returned errors; `Panicked` counts recovered panics.

## Verification

Run from this directory:

```sh
go test -race ./...
```

Additional checks used during development:

```sh
go vet ./...
go test -race -count=20 ./...
```

Output tail from the required command:

```text
ok  	pool	1.250s
```

## Known limitations

- `workers` and `queueSize` must both be positive; `New` panics otherwise.
- Error callbacks run synchronously on workers and should return promptly.
- Go cannot forcibly terminate a job function. After a shutdown timeout, the pool cancels job contexts as required, but a job that ignores cancellation can keep its worker alive until that function returns.
