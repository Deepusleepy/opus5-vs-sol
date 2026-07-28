// Package pool provides a bounded worker pool with graceful shutdown.
//
// A Pool runs jobs on a fixed number of worker goroutines fed by a bounded
// queue. Submit blocks when the queue is full but honors its context.
// Shutdown stops accepting work, drains the queue, and waits for in-flight
// jobs, falling back to cancelling them if its own context expires.
package pool

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
)

// ErrClosed is returned by Submit once Shutdown has been called.
var ErrClosed = errors.New("pool: closed")

// PanicError is the error reported to the error handler when a job panics.
type PanicError struct {
	// Value is the value passed to panic.
	Value any
	// Stack is the stack trace of the panicking goroutine.
	Stack []byte
}

func (e *PanicError) Error() string {
	return fmt.Sprintf("pool: job panicked: %v", e.Value)
}

// Stats is a snapshot of a pool's counters. Each job that is accepted
// increments Submitted, and each job that runs lands in exactly one of
// Completed, Failed or Panicked. Submitted may exceed the sum of the other
// three: queued jobs are abandoned when Shutdown's context expires.
type Stats struct {
	// Submitted counts jobs accepted onto the queue.
	Submitted uint64
	// Completed counts jobs that returned a nil error.
	Completed uint64
	// Failed counts jobs that returned a non-nil error.
	Failed uint64
	// Panicked counts jobs that panicked.
	Panicked uint64
}

// Pool is a bounded worker pool. The zero value is not usable; call New.
type Pool struct {
	jobs    chan func(context.Context) error
	closing chan struct{} // closed on Shutdown; wakes blocked Submits
	done    chan struct{} // closed when every worker has returned

	jobCtx    context.Context    // passed to jobs
	cancelJob context.CancelFunc // cancels in-flight jobs

	closeOnce sync.Once
	workers   sync.WaitGroup // worker goroutines
	senders   sync.WaitGroup // Submit calls that may still send on jobs

	mu     sync.RWMutex
	closed bool
	onErr  func(error)

	statsMu sync.Mutex
	stats   Stats
}

// New creates a pool with the given number of workers and queue capacity.
// A queueSize of 0 makes Submit wait for a free worker. It panics if
// workers < 1 or queueSize < 0.
func New(workers, queueSize int) *Pool {
	if workers < 1 {
		panic("pool: workers must be >= 1")
	}
	if queueSize < 0 {
		panic("pool: queueSize must be >= 0")
	}

	ctx, cancel := context.WithCancel(context.Background())
	p := &Pool{
		jobs:      make(chan func(context.Context) error, queueSize),
		closing:   make(chan struct{}),
		done:      make(chan struct{}),
		jobCtx:    ctx,
		cancelJob: cancel,
	}

	p.workers.Add(workers)
	for i := 0; i < workers; i++ {
		go p.work()
	}
	go func() {
		p.workers.Wait()
		close(p.done)
	}()
	return p
}

// SetErrorHandler installs fn, which is called for every job that returns a
// non-nil error or panics; panics are reported as *PanicError. fn is invoked
// on the worker goroutine, so it should not block for long, and it must not
// call SetErrorHandler. Passing nil disables reporting.
func (p *Pool) SetErrorHandler(fn func(error)) {
	p.mu.Lock()
	p.onErr = fn
	p.mu.Unlock()
}

// Submit enqueues job. It blocks while the queue is full and returns
// ctx.Err() if ctx is cancelled while waiting, or ErrClosed if the pool is
// shutting down. Jobs are run with a pool-owned context that is cancelled
// only when Shutdown times out; ctx governs submission, not execution.
func (p *Pool) Submit(ctx context.Context, job func(context.Context) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	// Register as a sender so Shutdown cannot close p.jobs underneath us.
	p.mu.RLock()
	if p.closed {
		p.mu.RUnlock()
		return ErrClosed
	}
	p.senders.Add(1)
	p.mu.RUnlock()
	defer p.senders.Done()

	select {
	case p.jobs <- job:
		p.statsMu.Lock()
		p.stats.Submitted++
		p.statsMu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-p.closing:
		return ErrClosed
	}
}

// Shutdown stops the pool from accepting new jobs, waits for queued and
// in-flight jobs to finish, and returns nil. If ctx expires first, the
// context passed to in-flight jobs is cancelled, remaining queued jobs are
// abandoned, and Shutdown returns ctx.Err() once all workers have stopped.
// Shutdown is safe to call multiple times and from multiple goroutines.
func (p *Pool) Shutdown(ctx context.Context) error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closed = true
		p.mu.Unlock()

		// Wake any Submit blocked on a full queue; those calls return
		// ErrClosed and drop their sender registration.
		close(p.closing)

		// Closing p.jobs is what tells workers to drain and exit, but it is
		// only safe once no Submit can still be sending.
		go func() {
			p.senders.Wait()
			close(p.jobs)
		}()
	})

	// Prefer a clean result when the pool has already stopped, so a Shutdown
	// called with an expired context after the work is done still reports nil.
	select {
	case <-p.done:
		p.cancelJob() // release the context's resources
		return nil
	default:
	}

	select {
	case <-p.done:
	case <-ctx.Done():
		p.cancelJob()
		<-p.done
		return ctx.Err()
	}
	p.cancelJob()
	return nil
}

// Stats returns a consistent snapshot of the pool's counters.
func (p *Pool) Stats() Stats {
	p.statsMu.Lock()
	defer p.statsMu.Unlock()
	return p.stats
}

func (p *Pool) work() {
	defer p.workers.Done()
	for job := range p.jobs {
		// Shutdown's context expired: abandon whatever is still queued.
		if p.jobCtx.Err() != nil {
			return
		}
		p.run(job)
	}
}

func (p *Pool) run(job func(context.Context) error) {
	// Set on the panic path so the report happens after the deferred recover
	// has restored the goroutine, and so a panicking error handler cannot
	// take the worker down with it.
	var panicErr *PanicError

	err := func() (err error) {
		defer func() {
			if r := recover(); r != nil {
				panicErr = &PanicError{Value: r, Stack: debug.Stack()}
			}
		}()
		return job(p.jobCtx)
	}()

	p.statsMu.Lock()
	switch {
	case panicErr != nil:
		p.stats.Panicked++
	case err != nil:
		p.stats.Failed++
	default:
		p.stats.Completed++
	}
	p.statsMu.Unlock()

	if panicErr != nil {
		err = panicErr
	}
	if err != nil {
		p.report(err)
	}
}

// report calls the error handler, if any, without letting a panic inside it
// kill the worker goroutine.
func (p *Pool) report(err error) {
	p.mu.RLock()
	fn := p.onErr
	p.mu.RUnlock()
	if fn == nil {
		return
	}
	defer func() { _ = recover() }()
	fn(err)
}
