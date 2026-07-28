// Package pool provides a bounded worker pool with graceful shutdown.
package pool

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
)

// ErrClosed is returned by Submit after shutdown has started.
var ErrClosed = errors.New("pool: closed")

// Stats is a point-in-time snapshot of a Pool's job counters.
//
// Completed counts every job that returned or panicked. Failed counts jobs
// that returned a non-nil error, while Panicked counts recovered panics.
type Stats struct {
	Submitted uint64
	Completed uint64
	Failed    uint64
	Panicked  uint64
}

// Pool executes submitted jobs with a fixed number of workers and a bounded
// queue. A Pool must be created with New.
type Pool struct {
	mu sync.Mutex

	jobs []func(context.Context) error
	head int
	size int

	accepting     bool
	activeWorkers int
	changed       chan struct{}
	done          chan struct{}

	workCtx    context.Context
	cancelWork context.CancelFunc

	errorHandler func(error)
	stats        Stats
}

// New creates a Pool with workers worker goroutines and room for queueSize
// waiting jobs. It panics if workers or queueSize is not positive.
func New(workers, queueSize int) *Pool {
	if workers <= 0 {
		panic("pool: workers must be positive")
	}
	if queueSize <= 0 {
		panic("pool: queue size must be positive")
	}

	workCtx, cancelWork := context.WithCancel(context.Background())
	p := &Pool{
		jobs:          make([]func(context.Context) error, queueSize),
		accepting:     true,
		activeWorkers: workers,
		changed:       make(chan struct{}),
		done:          make(chan struct{}),
		workCtx:       workCtx,
		cancelWork:    cancelWork,
	}
	for i := 0; i < workers; i++ {
		go p.worker()
	}
	return p
}

// SetErrorHandler sets the callback invoked for non-nil job errors and
// recovered panics. Passing nil clears the callback. The handler is called
// synchronously by a worker and should return promptly. A panic in the handler
// is recovered so it cannot stop a worker.
func (p *Pool) SetErrorHandler(handler func(error)) {
	p.mu.Lock()
	p.errorHandler = handler
	p.mu.Unlock()
}

// Submit adds job to the pool. It waits for queue capacity when the queue is
// full, returning ctx.Err() if ctx is canceled first. Once shutdown starts,
// Submit returns ErrClosed and never accepts another job.
func (p *Pool) Submit(ctx context.Context, job func(context.Context) error) error {
	for {
		p.mu.Lock()
		if !p.accepting {
			p.mu.Unlock()
			return ErrClosed
		}
		if err := ctx.Err(); err != nil {
			p.mu.Unlock()
			return err
		}
		if p.size < len(p.jobs) {
			index := (p.head + p.size) % len(p.jobs)
			p.jobs[index] = job
			p.size++
			p.stats.Submitted++
			p.signalLocked()
			p.mu.Unlock()
			return nil
		}

		changed := p.changed
		p.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
	}
}

// Shutdown stops accepting jobs, drains the queue, and waits for all workers
// to exit. If ctx expires first, Shutdown cancels the contexts passed to jobs
// and returns ctx.Err(). Further calls are safe and may wait for workers that
// were still finishing after an earlier timeout.
func (p *Pool) Shutdown(ctx context.Context) error {
	p.mu.Lock()
	if p.accepting {
		p.accepting = false
		p.signalLocked()
	}
	done := p.done
	p.mu.Unlock()

	select {
	case <-done:
		p.cancelWork()
		return nil
	default:
	}

	select {
	case <-done:
		p.cancelWork()
		return nil
	case <-ctx.Done():
		p.cancelWork()
		return ctx.Err()
	}
}

// Stats returns a concurrency-safe snapshot of the pool's counters.
func (p *Pool) Stats() Stats {
	p.mu.Lock()
	stats := p.stats
	p.mu.Unlock()
	return stats
}

func (p *Pool) worker() {
	for {
		p.mu.Lock()
		for p.size == 0 && p.accepting {
			changed := p.changed
			p.mu.Unlock()
			<-changed
			p.mu.Lock()
		}

		if p.size == 0 {
			p.activeWorkers--
			if p.activeWorkers == 0 {
				close(p.done)
			}
			p.mu.Unlock()
			return
		}

		job := p.jobs[p.head]
		p.jobs[p.head] = nil
		p.head = (p.head + 1) % len(p.jobs)
		p.size--
		p.signalLocked()
		p.mu.Unlock()

		err, panicked := runJob(p.workCtx, job)

		p.mu.Lock()
		p.stats.Completed++
		if panicked {
			p.stats.Panicked++
		} else if err != nil {
			p.stats.Failed++
		}
		handler := p.errorHandler
		p.mu.Unlock()

		if err != nil && handler != nil {
			callErrorHandler(handler, err)
		}
	}
}

func (p *Pool) signalLocked() {
	close(p.changed)
	p.changed = make(chan struct{})
}

func runJob(ctx context.Context, job func(context.Context) error) (err error, panicked bool) {
	defer func() {
		if value := recover(); value != nil {
			panicked = true
			err = fmt.Errorf("pool: job panicked: %v\n%s", value, debug.Stack())
		}
	}()
	return job(ctx), false
}

func callErrorHandler(handler func(error), err error) {
	defer func() {
		_ = recover()
	}()
	handler(err)
}
