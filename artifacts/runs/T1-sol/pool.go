// Package pool provides a bounded concurrent worker pool.
package pool

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
	"sync/atomic"
)

var (
	// ErrClosed is returned when a job is submitted after shutdown starts.
	ErrClosed = errors.New("pool: closed")
	// ErrNilJob is returned when a nil job is submitted.
	ErrNilJob = errors.New("pool: nil job")
)

// PanicError describes a panic recovered while running a job.
type PanicError struct {
	Value any
	Stack []byte
}

func (e *PanicError) Error() string {
	return fmt.Sprintf("pool: job panicked: %v", e.Value)
}

// Stats is a point-in-time snapshot of a Pool's counters. Completed includes
// every job that returned or panicked. Failed counts non-nil error returns;
// Panicked counts recovered panics.
type Stats struct {
	Submitted uint64
	Completed uint64
	Failed    uint64
	Panicked  uint64
}

type counters struct {
	submitted atomic.Uint64
	completed atomic.Uint64
	failed    atomic.Uint64
	panicked  atomic.Uint64
}

type queuedJob struct {
	fn func(context.Context) error
	ok bool
}

// Pool is a fixed-size worker pool with a bounded waiting queue.
type Pool struct {
	mu        sync.Mutex
	queue     []queuedJob
	queueSize int
	waiters   []chan queuedJob
	changed   chan struct{}
	closed    bool
	closedCh  chan struct{}

	jobCtx     context.Context
	cancelJobs context.CancelFunc

	workersDone  chan struct{}
	workerWG     sync.WaitGroup
	shutdownOnce sync.Once

	handlerMu sync.RWMutex
	handler   func(error)

	stats counters
}

// New starts workers and returns a pool whose waiting queue holds at most
// queueSize jobs. A queueSize of zero creates an unbuffered handoff. New
// panics if workers is not positive or queueSize is negative.
func New(workers, queueSize int) *Pool {
	if workers <= 0 {
		panic("pool: workers must be positive")
	}
	if queueSize < 0 {
		panic("pool: queue size must not be negative")
	}

	jobCtx, cancelJobs := context.WithCancel(context.Background())
	p := &Pool{
		queueSize:   queueSize,
		changed:     make(chan struct{}),
		closedCh:    make(chan struct{}),
		jobCtx:      jobCtx,
		cancelJobs:  cancelJobs,
		workersDone: make(chan struct{}),
	}
	p.workerWG.Add(workers)
	for range workers {
		go p.worker()
	}
	go func() {
		p.workerWG.Wait()
		p.cancelJobs()
		close(p.workersDone)
	}()
	return p
}

// SetErrorHandler sets the callback used for job errors and recovered panics.
// Workers may invoke the callback concurrently. A panic in the callback is
// recovered so it cannot stop a worker. Passing nil disables reporting.
func (p *Pool) SetErrorHandler(handler func(error)) {
	p.handlerMu.Lock()
	p.handler = handler
	p.handlerMu.Unlock()
}

// Submit adds job to the pool. It blocks while the bounded queue is full and
// returns ctx.Err if ctx is canceled before the job is accepted.
func (p *Pool) Submit(ctx context.Context, job func(context.Context) error) error {
	if ctx == nil {
		panic("pool: nil context")
	}
	if job == nil {
		return ErrNilJob
	}

	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return ErrClosed
		}

		qj := queuedJob{fn: job, ok: true}
		if len(p.waiters) > 0 {
			waiter := p.waiters[0]
			p.waiters = p.waiters[1:]
			p.stats.submitted.Add(1)
			waiter <- qj
			p.mu.Unlock()
			return nil
		}
		if len(p.queue) < p.queueSize {
			p.queue = append(p.queue, qj)
			p.stats.submitted.Add(1)
			p.mu.Unlock()
			return nil
		}

		changed := p.changed
		p.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-p.closedCh:
			return ErrClosed
		case <-changed:
		}
	}
}

// Shutdown stops accepting jobs, drains accepted jobs, and waits for workers.
// If ctx expires first, all job contexts are canceled and ctx.Err is returned.
// Repeated and concurrent calls are safe.
func (p *Pool) Shutdown(ctx context.Context) error {
	if ctx == nil {
		panic("pool: nil context")
	}
	p.shutdownOnce.Do(p.startShutdown)

	// Prefer a completed shutdown if both signals are already ready.
	select {
	case <-p.workersDone:
		return nil
	default:
	}
	select {
	case <-p.workersDone:
		return nil
	case <-ctx.Done():
		p.cancelJobs()
		return ctx.Err()
	}
}

func (p *Pool) startShutdown() {
	p.mu.Lock()
	p.closed = true
	close(p.closedCh)
	for _, waiter := range p.waiters {
		waiter <- queuedJob{}
	}
	p.waiters = nil
	p.notifyLocked()
	p.mu.Unlock()
}

// Stats returns a concurrently safe snapshot of the pool's counters.
func (p *Pool) Stats() Stats {
	return Stats{
		Submitted: p.stats.submitted.Load(),
		Completed: p.stats.completed.Load(),
		Failed:    p.stats.failed.Load(),
		Panicked:  p.stats.panicked.Load(),
	}
}

func (p *Pool) worker() {
	defer p.workerWG.Done()
	for {
		qj, ok := p.nextJob()
		if !ok {
			return
		}
		p.run(qj.fn)
	}
}

func (p *Pool) nextJob() (queuedJob, bool) {
	p.mu.Lock()
	if len(p.queue) > 0 {
		qj := p.queue[0]
		p.queue[0] = queuedJob{}
		p.queue = p.queue[1:]
		p.notifyLocked()
		p.mu.Unlock()
		return qj, true
	}
	if p.closed {
		p.mu.Unlock()
		return queuedJob{}, false
	}

	waiter := make(chan queuedJob, 1)
	p.waiters = append(p.waiters, waiter)
	p.notifyLocked()
	p.mu.Unlock()

	qj := <-waiter
	return qj, qj.ok
}

func (p *Pool) notifyLocked() {
	close(p.changed)
	p.changed = make(chan struct{})
}

func (p *Pool) run(job func(context.Context) error) {
	defer func() {
		if value := recover(); value != nil {
			p.stats.panicked.Add(1)
			p.report(&PanicError{Value: value, Stack: debug.Stack()})
		}
		p.stats.completed.Add(1)
	}()

	if err := job(p.jobCtx); err != nil {
		p.stats.failed.Add(1)
		p.report(err)
	}
}

func (p *Pool) report(err error) {
	p.handlerMu.RLock()
	handler := p.handler
	p.handlerMu.RUnlock()
	if handler == nil {
		return
	}
	defer func() { _ = recover() }()
	handler(err)
}
