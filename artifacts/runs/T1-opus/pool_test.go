package pool

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out after %v waiting for %s", d, what)
}

func TestSubmitAndRun(t *testing.T) {
	p := New(4, 8)
	var n atomic.Int64
	for i := 0; i < 20; i++ {
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
	if got := n.Load(); got != 20 {
		t.Fatalf("ran %d jobs, want 20", got)
	}
	st := p.Stats()
	if st.Submitted != 20 || st.Completed != 20 || st.Failed != 0 || st.Panicked != 0 {
		t.Fatalf("unexpected stats: %+v", st)
	}
}

// Submit must return promptly when its context is cancelled while it is
// blocked on a full queue.
func TestSubmitCancelledWhileQueueFull(t *testing.T) {
	p := New(1, 1)
	release := make(chan struct{})
	// Occupy the single worker.
	if err := p.Submit(context.Background(), func(context.Context) error {
		<-release
		return nil
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	// Fill the single queue slot.
	if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		errc <- p.Submit(ctx, func(context.Context) error { return nil })
	}()

	select {
	case err := <-errc:
		t.Fatalf("Submit returned early with %v, want it to block", err)
	case <-time.After(50 * time.Millisecond):
	}

	cancel()
	select {
	case err := <-errc:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Submit err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Submit did not observe context cancellation")
	}

	close(release)
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if st := p.Stats(); st.Submitted != 2 || st.Completed != 2 {
		t.Fatalf("unexpected stats: %+v", st)
	}
}

// An already-expired context is honoured even if the queue has room.
func TestSubmitExpiredContext(t *testing.T) {
	p := New(1, 4)
	defer p.Shutdown(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := p.Submit(ctx, func(context.Context) error { return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Submit err = %v, want context.Canceled", err)
	}
}

// Shutdown with a live context must run every job that was already queued.
func TestShutdownDrainsQueue(t *testing.T) {
	p := New(2, 50)
	start := make(chan struct{})
	var done atomic.Int64
	const jobs = 40
	for i := 0; i < jobs; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error {
			<-start
			done.Add(1)
			return nil
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	close(start)
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if got := done.Load(); got != jobs {
		t.Fatalf("drained %d jobs, want %d", got, jobs)
	}
}

// When Shutdown's context expires, in-flight jobs get their context cancelled
// and Shutdown reports ctx.Err().
func TestShutdownTimeoutCancelsInFlight(t *testing.T) {
	p := New(2, 10)
	running := make(chan struct{}, 2)
	var cancelled atomic.Int64
	for i := 0; i < 2; i++ {
		if err := p.Submit(context.Background(), func(ctx context.Context) error {
			running <- struct{}{}
			<-ctx.Done()
			cancelled.Add(1)
			return ctx.Err()
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	// Queue extra work that should be discarded rather than started.
	var extra atomic.Int64
	for i := 0; i < 5; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error {
			extra.Add(1)
			return nil
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	<-running
	<-running

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := p.Shutdown(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown err = %v, want context.DeadlineExceeded", err)
	}
	if got := cancelled.Load(); got != 2 {
		t.Fatalf("%d in-flight jobs saw cancellation, want 2", got)
	}
	if got := extra.Load(); got != 0 {
		t.Fatalf("%d queued jobs ran after the deadline, want 0", got)
	}
}

func TestDoubleShutdown(t *testing.T) {
	p := New(3, 3)
	if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("first Shutdown: %v", err)
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("second Shutdown: %v", err)
	}

	// Concurrent shutdowns must all return without panicking.
	q := New(2, 2)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := q.Shutdown(context.Background()); err != nil {
				t.Errorf("concurrent Shutdown: %v", err)
			}
		}()
	}
	wg.Wait()
}

func TestSubmitAfterShutdown(t *testing.T) {
	p := New(2, 2)
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	err := p.Submit(context.Background(), func(context.Context) error { return nil })
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("Submit err = %v, want ErrClosed", err)
	}
	if st := p.Stats(); st.Submitted != 0 {
		t.Fatalf("rejected submit was counted: %+v", st)
	}
}

// A Submit blocked on a full queue unblocks with ErrClosed when the pool is
// shut down concurrently.
func TestBlockedSubmitUnblocksOnShutdown(t *testing.T) {
	p := New(1, 1)
	release := make(chan struct{})
	if err := p.Submit(context.Background(), func(context.Context) error {
		<-release
		return nil
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	errc := make(chan error, 1)
	go func() {
		errc <- p.Submit(context.Background(), func(context.Context) error { return nil })
	}()
	time.Sleep(50 * time.Millisecond) // let the third Submit block

	shutdownDone := make(chan error, 1)
	go func() { shutdownDone <- p.Shutdown(context.Background()) }()

	select {
	case err := <-errc:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("blocked Submit err = %v, want ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("blocked Submit never returned")
	}

	close(release)
	if err := <-shutdownDone; err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

func TestPanicRecovery(t *testing.T) {
	p := New(2, 4)
	var mu sync.Mutex
	var errs []error
	p.OnError(func(err error) {
		mu.Lock()
		errs = append(errs, err)
		mu.Unlock()
	})

	if err := p.Submit(context.Background(), func(context.Context) error { panic("boom") }); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	sentinel := errors.New("bad")
	if err := p.Submit(context.Background(), func(context.Context) error { return sentinel }); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	// The workers must still be alive after the panic.
	var ok atomic.Int64
	for i := 0; i < 10; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error {
			ok.Add(1)
			return nil
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	if got := ok.Load(); got != 10 {
		t.Fatalf("%d jobs ran after the panic, want 10", got)
	}
	st := p.Stats()
	if st.Submitted != 12 || st.Completed != 10 || st.Failed != 2 || st.Panicked != 1 {
		t.Fatalf("unexpected stats: %+v", st)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(errs) != 2 {
		t.Fatalf("callback saw %d errors, want 2", len(errs))
	}
	var pe *PanicError
	var sawPanic, sawSentinel bool
	for _, err := range errs {
		if errors.As(err, &pe) {
			sawPanic = true
			if pe.Value != "boom" {
				t.Fatalf("PanicError.Value = %v, want boom", pe.Value)
			}
			if len(pe.Stack) == 0 {
				t.Fatal("PanicError.Stack is empty")
			}
		}
		if errors.Is(err, sentinel) {
			sawSentinel = true
		}
	}
	if !sawPanic || !sawSentinel {
		t.Fatalf("callback errors incomplete: panic=%v sentinel=%v", sawPanic, sawSentinel)
	}
}

func TestStatsConcurrentWithSubmit(t *testing.T) {
	p := New(4, 16)
	stop := make(chan struct{})
	var readers sync.WaitGroup
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
	for i := 0; i < 200; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	close(stop)
	readers.Wait()
	if st := p.Stats(); st.Submitted != 200 || st.Completed != 200 {
		t.Fatalf("unexpected stats: %+v", st)
	}
}

// Every path — clean shutdown, timed-out shutdown, cancelled submits and
// panicking jobs — must leave no goroutines behind.
func TestNoGoroutineLeak(t *testing.T) {
	runtime.GC()
	before := runtime.NumGoroutine()

	for i := 0; i < 20; i++ {
		// Clean drain.
		p := New(4, 8)
		for j := 0; j < 16; j++ {
			if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
				t.Fatalf("Submit: %v", err)
			}
		}
		if err := p.Shutdown(context.Background()); err != nil {
			t.Fatalf("Shutdown: %v", err)
		}

		// Panicking jobs.
		q := New(2, 4)
		q.OnError(func(error) {})
		for j := 0; j < 4; j++ {
			if err := q.Submit(context.Background(), func(context.Context) error { panic("boom") }); err != nil {
				t.Fatalf("Submit: %v", err)
			}
		}
		if err := q.Shutdown(context.Background()); err != nil {
			t.Fatalf("Shutdown: %v", err)
		}

		// Shutdown deadline expiry with a blocked worker and a blocked Submit.
		r := New(1, 1)
		if err := r.Submit(context.Background(), func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
		if err := r.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
			t.Fatalf("Submit: %v", err)
		}
		blocked := make(chan error, 1)
		go func() {
			blocked <- r.Submit(context.Background(), func(context.Context) error { return nil })
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		if err := r.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
			cancel()
			t.Fatalf("Shutdown err = %v, want context.DeadlineExceeded", err)
		}
		cancel()
		if err := <-blocked; !errors.Is(err, ErrClosed) {
			t.Fatalf("blocked Submit err = %v, want ErrClosed", err)
		}

		// Submit cancelled while blocked on a full queue.
		s := New(1, 1)
		hold := make(chan struct{})
		if err := s.Submit(context.Background(), func(context.Context) error { <-hold; return nil }); err != nil {
			t.Fatalf("Submit: %v", err)
		}
		if err := s.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
			t.Fatalf("Submit: %v", err)
		}
		sctx, scancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		if err := s.Submit(sctx, func(context.Context) error { return nil }); !errors.Is(err, context.DeadlineExceeded) {
			scancel()
			t.Fatalf("Submit err = %v, want context.DeadlineExceeded", err)
		}
		scancel()
		close(hold)
		if err := s.Shutdown(context.Background()); err != nil {
			t.Fatalf("Shutdown: %v", err)
		}
	}

	// Give the runtime a moment to reap goroutines that have already returned.
	var after int
	waitFor(t, 5*time.Second, "goroutine count to settle", func() bool {
		runtime.GC()
		after = runtime.NumGoroutine()
		return after <= before+2
	})
	if after > before+2 {
		t.Fatalf("goroutine leak: before=%d after=%d", before, after)
	}
}
