// Package pool provides a bounded worker pool with graceful shutdown.
//
// A Pool runs a fixed number of worker goroutines that execute jobs taken from
// a bounded queue. Submit blocks while the queue is full, Shutdown drains what
// has already been queued, and job panics are recovered so they never take a
// worker down.
package pool

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
	"sync/atomic"
)

// ErrClosed is returned by Submit once Shutdown has been called.
var ErrClosed = errors.New("pool: closed")

// Job is the unit of work executed by a worker. The context passed to a job is
// cancelled if Shutdown's own context expires before the job finishes.
type Job func(context.Context) error

// PanicError wraps a value recovered from a panicking job.
type PanicError struct {
	Value any
	Stack []byte
}

func (e *PanicError) Error() string {
	return fmt.Sprintf("pool: job panicked: %v", e.Value)
}

// Stats is a snapshot of a pool's counters.
type Stats struct {
	Submitted uint64 // jobs accepted onto the queue
	Completed uint64 // jobs that returned nil
	Failed    uint64 // jobs that returned a non-nil error (panics are counted here too)
	Panicked  uint64 // jobs that panicked
}

// Pool is a bounded worker pool. The zero value is not usable; use New.
type Pool struct {
	jobs chan Job
	wg   sync.WaitGroup // workers

	// mu guards the close of closing against concurrent senders.Add.
	mu      sync.RWMutex
	closing chan struct{}
	senders sync.WaitGroup // in-flight Submit calls that may still send

	closeOnce sync.Once

	jobCtx    context.Context
	cancelJob context.CancelFunc

	errMu sync.RWMutex
	onErr func(error)

	submitted atomic.Uint64
	completed atomic.Uint64
	failed    atomic.Uint64
	panicked  atomic.Uint64
}

// New creates a pool with the given number of workers and queue capacity.
// workers is clamped to a minimum of 1; a queueSize of 0 makes Submit block
// until a worker is free.
func New(workers, queueSize int) *Pool {
	if workers < 1 {
		workers = 1
	}
	if queueSize < 0 {
		queueSize = 0
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &Pool{
		jobs:      make(chan Job, queueSize),
		closing:   make(chan struct{}),
		jobCtx:    ctx,
		cancelJob: cancel,
	}
	p.wg.Add(workers)
	for i := 0; i < workers; i++ {
		go p.worker()
	}
	return p
}

// OnError registers a callback invoked for every job that returns an error or
// panics (panics arrive as *PanicError). It is called from worker goroutines,
// so it must be safe for concurrent use and should not block. Passing nil
// clears the callback.
func (p *Pool) OnError(fn func(error)) {
	p.errMu.Lock()
	p.onErr = fn
	p.errMu.Unlock()
}

// Submit enqueues job. It blocks while the queue is full, returning early with
// ctx.Err() if ctx is cancelled or ErrClosed if the pool shuts down meanwhile.
func (p *Pool) Submit(ctx context.Context, job Job) error {
	if job == nil {
		return errors.New("pool: nil job")
	}

	// Register as a sender so Shutdown cannot close the job channel underneath
	// us. The lock is only held for this bookkeeping, never while blocked.
	p.mu.RLock()
	select {
	case <-p.closing:
		p.mu.RUnlock()
		return ErrClosed
	default:
	}
	p.senders.Add(1)
	p.mu.RUnlock()
	defer p.senders.Done()

	// ctx may already be cancelled; check it before racing with a free slot.
	if err := ctx.Err(); err != nil {
		return err
	}

	select {
	case p.jobs <- job:
		p.submitted.Add(1)
		return nil
	case <-p.closing:
		return ErrClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Shutdown stops the pool from accepting new jobs, drains the queue and waits
// for in-flight jobs to finish. If ctx expires first, the contexts handed to
// running jobs are cancelled, queued-but-unstarted jobs are discarded, and
// ctx.Err() is returned. Shutdown is safe to call more than once and from
// multiple goroutines; every call waits for the workers to exit.
func (p *Pool) Shutdown(ctx context.Context) error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		close(p.closing)
		p.mu.Unlock()
		// Every blocked Submit now observes closing and returns, so this wait
		// is bounded and no send can happen after the channel is closed.
		p.senders.Wait()
		close(p.jobs)
	})

	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		p.cancelJob()
		return nil
	case <-ctx.Done():
		p.cancelJob()
		<-done // never return while workers are still running
		return ctx.Err()
	}
}

// Stats returns a snapshot of the pool counters. It is safe to call at any
// time, including concurrently with Submit and Shutdown.
func (p *Pool) Stats() Stats {
	return Stats{
		Submitted: p.submitted.Load(),
		Completed: p.completed.Load(),
		Failed:    p.failed.Load(),
		Panicked:  p.panicked.Load(),
	}
}

func (p *Pool) worker() {
	defer p.wg.Done()
	for {
		// Give up before starting more work if Shutdown's deadline has passed.
		// Checked first so a cancelled pool never starts a queued job, which a
		// single combined select would do at random.
		select {
		case <-p.jobCtx.Done():
			return
		default:
		}

		select {
		case job, ok := <-p.jobs:
			if !ok {
				return
			}
			p.run(job)
		case <-p.jobCtx.Done():
			// Shutdown's deadline expired: drop whatever is still queued.
			return
		}
	}
}

func (p *Pool) run(job Job) {
	var err error
	defer func() {
		if r := recover(); r != nil {
			p.panicked.Add(1)
			p.failed.Add(1)
			p.report(&PanicError{Value: r, Stack: debug.Stack()})
			return
		}
		if err != nil {
			p.failed.Add(1)
			p.report(err)
			return
		}
		p.completed.Add(1)
	}()
	err = job(p.jobCtx)
}

func (p *Pool) report(err error) {
	p.errMu.RLock()
	fn := p.onErr
	p.errMu.RUnlock()
	if fn != nil {
		fn(err)
	}
}
