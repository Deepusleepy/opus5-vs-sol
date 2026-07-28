# T1 — Go: bounded worker pool with graceful shutdown

Implement a production-quality worker pool package `pool` in Go (standard library only).

Requirements:
- `New(workers, queueSize int) *Pool` — bounded queue; `Submit(ctx context.Context, job func(context.Context) error) error` blocks when the queue is full but must honor ctx cancellation while blocked.
- `Shutdown(ctx context.Context) error` — stops accepting new jobs immediately, drains already-queued jobs, waits for in-flight jobs; if ctx expires first, cancels in-flight job contexts and returns ctx.Err(). Calling Shutdown twice must be safe. Submit after Shutdown returns a sentinel error `ErrClosed`.
- Job panics must not kill workers; they are recovered and reported through an error callback the caller can set. The pool must never leak goroutines in any path.
- Collect per-pool stats (submitted, completed, failed, panicked) readable concurrently via a `Stats()` snapshot.

Deliverables in this directory only:
- `go.mod` (module name `pool`), implementation, and `pool_test.go` covering: cancellation while blocked on a full queue, shutdown draining, shutdown timeout cancelling in-flight jobs, double shutdown, submit-after-shutdown, panic recovery, and a goroutine-leak check (compare runtime.NumGoroutine before/after with tolerance, or use a stricter technique).
- All tests must pass with `go test -race ./...`. Run it and include the output tail in SUMMARY.md.
- `SUMMARY.md`: what you built, how to verify, any known limitations. Do not mention any AI model names anywhere.

Keep it as simple as the requirements allow. Unused abstractions, config options nobody asked for, or speculative interfaces count against you.
