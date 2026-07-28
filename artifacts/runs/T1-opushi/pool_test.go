package pool

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// blockingJob returns a job that signals when it starts and then waits until
// release is closed or its context is cancelled. It reports whether it left
// because of cancellation.
func blockingJob(started chan<- struct{}, release <-chan struct{}, cancelled *atomic.Bool) func(context.Context) error {
	var once sync.Once
	return func(ctx context.Context) error {
		once.Do(func() { close(started) })
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			cancelled.Store(true)
			return ctx.Err()
		}
	}
}

func TestSubmitRunsJobs(t *testing.T) {
	p := New(4, 8)
	defer func() {
		if err := p.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	}()

	var n atomic.Int64
	for i := 0; i < 50; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error {
			n.Add(1)
			return nil
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if got := n.Load(); got != 50 {
		t.Errorf("ran %d jobs, want 50", got)
	}
	if s := p.Stats(); s.Submitted != 50 || s.Completed != 50 || s.Failed != 0 || s.Panicked != 0 {
		t.Errorf("Stats() = %+v, want Submitted/Completed 50 and no failures", s)
	}
}

// Requirement: Submit blocks when the queue is full but honors ctx
// cancellation while blocked.
func TestSubmitCancelledWhileQueueFull(t *testing.T) {
	p := New(1, 1) // one worker, one queue slot
	defer p.Shutdown(context.Background())

	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	var cancelled atomic.Bool

	// Occupy the single worker, then fill the single queue slot.
	if err := p.Submit(context.Background(), blockingJob(started, release, &cancelled)); err != nil {
		t.Fatalf("Submit(worker): %v", err)
	}
	<-started
	if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("Submit(queue): %v", err)
	}

	// The pool is now saturated: this Submit must block, then unblock on ctx.
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		errc <- p.Submit(ctx, func(context.Context) error { return nil })
	}()

	select {
	case err := <-errc:
		t.Fatalf("Submit returned %v while the pool was saturated; it must block", err)
	case <-time.After(50 * time.Millisecond):
	}

	cancel()
	select {
	case err := <-errc:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Submit returned %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Submit did not return after its context was cancelled")
	}

	// The rejected job must not have been queued.
	if s := p.Stats(); s.Submitted != 2 {
		t.Errorf("Stats().Submitted = %d, want 2", s.Submitted)
	}
}

func TestSubmitWithAlreadyCancelledContext(t *testing.T) {
	p := New(2, 4)
	defer p.Shutdown(context.Background())

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var ran atomic.Bool
	err := p.Submit(ctx, func(context.Context) error {
		ran.Store(true)
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Submit = %v, want context.Canceled", err)
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if ran.Load() {
		t.Error("job ran despite Submit returning an error")
	}
}

// Requirement: Shutdown drains already-queued jobs.
func TestShutdownDrainsQueuedJobs(t *testing.T) {
	const queued = 32
	p := New(2, queued+2)

	started := make(chan struct{})
	release := make(chan struct{})
	var cancelled atomic.Bool

	// Hold one worker so the rest of the jobs pile up in the queue.
	if err := p.Submit(context.Background(), blockingJob(started, release, &cancelled)); err != nil {
		t.Fatalf("Submit(blocker): %v", err)
	}
	<-started

	var ran atomic.Int64
	for i := 0; i < queued; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error {
			ran.Add(1)
			return nil
		}); err != nil {
			t.Fatalf("Submit(%d): %v", i, err)
		}
	}

	// Shut down while work is still queued; release the blocker so the
	// in-flight job can finish on its own.
	errc := make(chan error, 1)
	go func() { errc <- p.Shutdown(context.Background()) }()
	time.Sleep(20 * time.Millisecond)
	close(release)

	select {
	case err := <-errc:
		if err != nil {
			t.Fatalf("Shutdown = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown did not return")
	}

	if got := ran.Load(); got != queued {
		t.Errorf("drained %d queued jobs, want %d", got, queued)
	}
	if cancelled.Load() {
		t.Error("in-flight job was cancelled during a graceful shutdown")
	}
	if s := p.Stats(); s.Completed != queued+1 {
		t.Errorf("Stats().Completed = %d, want %d", s.Completed, queued+1)
	}
}

// Requirement: if Shutdown's ctx expires first, in-flight job contexts are
// cancelled and ctx.Err() is returned.
func TestShutdownTimeoutCancelsInFlightJobs(t *testing.T) {
	p := New(2, 4)

	started1, started2 := make(chan struct{}), make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	var c1, c2 atomic.Bool

	if err := p.Submit(context.Background(), blockingJob(started1, release, &c1)); err != nil {
		t.Fatalf("Submit(1): %v", err)
	}
	if err := p.Submit(context.Background(), blockingJob(started2, release, &c2)); err != nil {
		t.Fatalf("Submit(2): %v", err)
	}
	<-started1
	<-started2

	// This job stays queued and must be abandoned, not run.
	var abandoned atomic.Bool
	if err := p.Submit(context.Background(), func(context.Context) error {
		abandoned.Store(true)
		return nil
	}); err != nil {
		t.Fatalf("Submit(3): %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- p.Shutdown(ctx) }()

	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Shutdown = %v, want context.DeadlineExceeded", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown did not return after its deadline passed")
	}

	// Shutdown only returns once workers have stopped, so both jobs must
	// already have observed cancellation.
	if !c1.Load() || !c2.Load() {
		t.Errorf("in-flight jobs cancelled = (%v, %v), want both true", c1.Load(), c2.Load())
	}
	if abandoned.Load() {
		t.Error("a queued job ran after the shutdown deadline passed")
	}

	// A later Shutdown must not hang and must still report ErrClosed to Submit.
	if err := p.Shutdown(context.Background()); err != nil {
		t.Errorf("second Shutdown = %v, want nil", err)
	}
	if err := p.Submit(context.Background(), func(context.Context) error { return nil }); !errors.Is(err, ErrClosed) {
		t.Errorf("Submit after shutdown = %v, want ErrClosed", err)
	}
}

func TestShutdownUnblocksBlockedSubmit(t *testing.T) {
	p := New(1, 0) // unbuffered: Submit waits for a free worker

	started := make(chan struct{})
	release := make(chan struct{})
	var cancelled atomic.Bool
	if err := p.Submit(context.Background(), blockingJob(started, release, &cancelled)); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	<-started

	errc := make(chan error, 1)
	go func() {
		errc <- p.Submit(context.Background(), func(context.Context) error { return nil })
	}()
	select {
	case err := <-errc:
		t.Fatalf("Submit returned %v while the only worker was busy", err)
	case <-time.After(50 * time.Millisecond):
	}

	shut := make(chan error, 1)
	go func() { shut <- p.Shutdown(context.Background()) }()

	select {
	case err := <-errc:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("blocked Submit = %v, want ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown did not unblock the pending Submit")
	}

	close(release)
	if err := <-shut; err != nil {
		t.Fatalf("Shutdown = %v, want nil", err)
	}
}

func TestDoubleShutdown(t *testing.T) {
	p := New(3, 3)
	for i := 0; i < 3; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	for i := 0; i < 3; i++ {
		if err := p.Shutdown(context.Background()); err != nil {
			t.Fatalf("Shutdown #%d = %v, want nil", i+1, err)
		}
	}
}

// A second Shutdown on an already-stopped pool reports success even if its own
// context is already expired: there is nothing left to wait for.
func TestShutdownWithExpiredContextAfterDrain(t *testing.T) {
	p := New(2, 4)
	if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.Shutdown(ctx); err != nil {
		t.Errorf("Shutdown(expired ctx) after drain = %v, want nil", err)
	}
	if s := p.Stats(); s.Completed != 1 {
		t.Errorf("Stats() = %+v, want Completed 1", s)
	}
}

func TestConcurrentShutdown(t *testing.T) {
	p := New(4, 8)
	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = p.Shutdown(context.Background())
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("concurrent Shutdown #%d = %v, want nil", i, err)
		}
	}
}

func TestSubmitAfterShutdown(t *testing.T) {
	p := New(2, 2)
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	var ran atomic.Bool
	for i := 0; i < 3; i++ {
		err := p.Submit(context.Background(), func(context.Context) error {
			ran.Store(true)
			return nil
		})
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("Submit after shutdown = %v, want ErrClosed", err)
		}
	}
	if ran.Load() {
		t.Error("a job submitted after shutdown ran")
	}
	if s := p.Stats(); s.Submitted != 0 {
		t.Errorf("Stats().Submitted = %d, want 0", s.Submitted)
	}
}

// Requirement: job panics are recovered, reported, and do not kill workers.
func TestPanicRecovery(t *testing.T) {
	p := New(1, 8) // one worker: if a panic killed it, later jobs would never run

	var mu sync.Mutex
	var got []error
	p.SetErrorHandler(func(err error) {
		mu.Lock()
		got = append(got, err)
		mu.Unlock()
	})

	if err := p.Submit(context.Background(), func(context.Context) error {
		panic("boom")
	}); err != nil {
		t.Fatalf("Submit(panic): %v", err)
	}

	var after atomic.Int64
	for i := 0; i < 5; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error {
			after.Add(1)
			return nil
		}); err != nil {
			t.Fatalf("Submit(after): %v", err)
		}
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	if n := after.Load(); n != 5 {
		t.Errorf("%d jobs ran after the panic, want 5 (the worker died)", n)
	}
	if s := p.Stats(); s.Panicked != 1 || s.Completed != 5 || s.Failed != 0 {
		t.Errorf("Stats() = %+v, want Panicked 1 and Completed 5", s)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("error handler called %d times, want 1", len(got))
	}
	var pe *PanicError
	if !errors.As(got[0], &pe) {
		t.Fatalf("handler got %T (%v), want *PanicError", got[0], got[0])
	}
	if pe.Value != "boom" {
		t.Errorf("PanicError.Value = %v, want \"boom\"", pe.Value)
	}
	if !strings.Contains(string(pe.Stack), "pool.") {
		t.Errorf("PanicError.Stack does not look like a stack trace: %q", pe.Stack)
	}
	if !strings.Contains(pe.Error(), "boom") {
		t.Errorf("PanicError.Error() = %q, want it to mention the panic value", pe.Error())
	}
}

func TestPanickingErrorHandlerDoesNotKillWorker(t *testing.T) {
	p := New(1, 4)
	p.SetErrorHandler(func(error) { panic("handler exploded") })

	if err := p.Submit(context.Background(), func(context.Context) error {
		return errors.New("job failed")
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	var ran atomic.Bool
	if err := p.Submit(context.Background(), func(context.Context) error {
		ran.Store(true)
		return nil
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if !ran.Load() {
		t.Error("worker died after the error handler panicked")
	}
}

func TestErrorsAreReported(t *testing.T) {
	p := New(2, 8)
	want := errors.New("nope")
	var count atomic.Int64
	p.SetErrorHandler(func(err error) {
		if !errors.Is(err, want) {
			t.Errorf("handler got %v, want %v", err, want)
		}
		count.Add(1)
	})

	for i := 0; i < 10; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error { return want }); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if count.Load() != 10 {
		t.Errorf("handler called %d times, want 10", count.Load())
	}
	if s := p.Stats(); s.Failed != 10 || s.Completed != 0 {
		t.Errorf("Stats() = %+v, want Failed 10", s)
	}
}

func TestNoErrorHandlerIsSafe(t *testing.T) {
	p := New(2, 4)
	if err := p.Submit(context.Background(), func(context.Context) error { return errors.New("x") }); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := p.Submit(context.Background(), func(context.Context) error { panic("y") }); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if s := p.Stats(); s.Failed != 1 || s.Panicked != 1 {
		t.Errorf("Stats() = %+v, want Failed 1 and Panicked 1", s)
	}
}

// Bounded queue: at most workers+queueSize jobs may be accepted while none
// complete.
func TestQueueIsBounded(t *testing.T) {
	const workers, queueSize = 2, 3
	p := New(workers, queueSize)

	release := make(chan struct{})
	defer close(release)
	var accepted int
	for i := 0; i < workers+queueSize+5; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		err := p.Submit(ctx, func(ctx context.Context) error {
			select {
			case <-release:
			case <-ctx.Done():
			}
			return nil
		})
		cancel()
		if err != nil {
			break
		}
		accepted++
	}
	if accepted != workers+queueSize {
		t.Errorf("accepted %d jobs before blocking, want %d", accepted, workers+queueSize)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := p.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Shutdown = %v, want DeadlineExceeded", err)
	}
}

func TestStatsUnderConcurrency(t *testing.T) {
	p := New(8, 16)
	p.SetErrorHandler(func(error) {})

	const n = 300
	var readers, submitters sync.WaitGroup
	stop := make(chan struct{})

	// Readers hammer Stats() while jobs run; -race proves this is safe.
	for i := 0; i < 4; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
					_ = p.Stats()
				}
			}
		}()
	}

	for i := 0; i < n; i++ {
		i := i
		submitters.Add(1)
		go func() {
			defer submitters.Done()
			err := p.Submit(context.Background(), func(context.Context) error {
				switch i % 3 {
				case 0:
					return nil
				case 1:
					return errors.New("fail")
				default:
					panic("kaboom")
				}
			})
			if err != nil {
				t.Errorf("Submit: %v", err)
			}
		}()
	}

	// Every job must be accepted before shutdown, otherwise the counts below
	// would be testing the race rather than the accounting.
	submitters.Wait()
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	close(stop)
	readers.Wait()

	s := p.Stats()
	if s.Submitted != n {
		t.Errorf("Submitted = %d, want %d", s.Submitted, n)
	}
	if total := s.Completed + s.Failed + s.Panicked; total != n {
		t.Errorf("Completed+Failed+Panicked = %d, want %d (%+v)", total, n, s)
	}
	if s.Completed != 100 || s.Failed != 100 || s.Panicked != 100 {
		t.Errorf("Stats() = %+v, want 100 of each outcome", s)
	}
}

// Submit racing Shutdown must never panic on a send to a closed channel and
// must never silently drop a job it reported as accepted.
func TestSubmitRacesShutdown(t *testing.T) {
	for iter := 0; iter < 50; iter++ {
		p := New(4, 4)
		var ran atomic.Int64
		var accepted atomic.Int64

		var wg sync.WaitGroup
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				err := p.Submit(context.Background(), func(context.Context) error {
					ran.Add(1)
					return nil
				})
				if err == nil {
					accepted.Add(1)
				} else if !errors.Is(err, ErrClosed) {
					t.Errorf("Submit = %v, want nil or ErrClosed", err)
				}
			}()
		}
		go func() {
			if err := p.Shutdown(context.Background()); err != nil {
				t.Errorf("Shutdown: %v", err)
			}
		}()
		wg.Wait()
		if err := p.Shutdown(context.Background()); err != nil {
			t.Fatalf("Shutdown: %v", err)
		}
		if ran.Load() != accepted.Load() {
			t.Fatalf("iteration %d: %d jobs accepted but %d ran", iter, accepted.Load(), ran.Load())
		}
		if s := p.Stats(); uint64(accepted.Load()) != s.Submitted {
			t.Fatalf("iteration %d: accepted %d but Stats().Submitted = %d", iter, accepted.Load(), s.Submitted)
		}
	}
}

// Requirement: the pool must not leak goroutines in any path. Every exit path
// is exercised, then the goroutine count is polled back down to its baseline.
func TestNoGoroutineLeak(t *testing.T) {
	baseline := stableGoroutines(t)

	for i := 0; i < 20; i++ {
		// Graceful path.
		p := New(4, 8)
		for j := 0; j < 16; j++ {
			if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
				t.Fatalf("Submit: %v", err)
			}
		}
		if err := p.Shutdown(context.Background()); err != nil {
			t.Fatalf("Shutdown: %v", err)
		}

		// Panic path.
		q := New(2, 2)
		q.SetErrorHandler(func(error) {})
		if err := q.Submit(context.Background(), func(context.Context) error { panic("leak?") }); err != nil {
			t.Fatalf("Submit: %v", err)
		}
		if err := q.Shutdown(context.Background()); err != nil {
			t.Fatalf("Shutdown: %v", err)
		}

		// Timeout path: workers are stuck, Shutdown gives up, queued jobs
		// are abandoned, and blocked Submits are released.
		r := New(2, 1)
		hold := make(chan struct{})
		for j := 0; j < 3; j++ {
			if err := r.Submit(context.Background(), func(ctx context.Context) error {
				select {
				case <-hold:
				case <-ctx.Done():
				}
				return nil
			}); err != nil {
				t.Fatalf("Submit: %v", err)
			}
		}
		blocked := make(chan error, 1)
		go func() {
			blocked <- r.Submit(context.Background(), func(context.Context) error { return nil })
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		if err := r.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
			cancel()
			t.Fatalf("Shutdown = %v, want DeadlineExceeded", err)
		}
		cancel()
		if err := <-blocked; !errors.Is(err, ErrClosed) {
			t.Fatalf("blocked Submit = %v, want ErrClosed", err)
		}
		close(hold)

		// Cancelled-Submit path.
		s := New(1, 0)
		busy := make(chan struct{})
		sctx, scancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		if err := s.Submit(context.Background(), func(ctx context.Context) error {
			<-busy
			return nil
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
		if err := s.Submit(sctx, func(context.Context) error { return nil }); !errors.Is(err, context.DeadlineExceeded) {
			scancel()
			t.Fatalf("Submit = %v, want DeadlineExceeded", err)
		}
		scancel()
		close(busy)
		if err := s.Shutdown(context.Background()); err != nil {
			t.Fatalf("Shutdown: %v", err)
		}
	}

	// Poll: unrelated runtime goroutines (and the ones we just released) may
	// take a moment to wind down.
	deadline := time.Now().Add(5 * time.Second)
	var got int
	for {
		runtime.GC()
		got = runtime.NumGoroutine()
		if got <= baseline+2 {
			return
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	buf := make([]byte, 1<<20)
	buf = buf[:runtime.Stack(buf, true)]
	t.Fatalf("goroutines: baseline %d, now %d (tolerance 2)\n%s", baseline, got, buf)
}

// stableGoroutines waits for the goroutine count to settle and returns it.
func stableGoroutines(t *testing.T) int {
	t.Helper()
	prev := -1
	for i := 0; i < 100; i++ {
		runtime.GC()
		n := runtime.NumGoroutine()
		if n == prev {
			return n
		}
		prev = n
		time.Sleep(10 * time.Millisecond)
	}
	return prev
}
