package pool

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testTimeout = 2 * time.Second

func TestSubmitCancellationWhileQueueFull(t *testing.T) {
	p := New(1, 1)
	started := make(chan struct{})
	release := make(chan struct{})

	if err := p.Submit(context.Background(), func(context.Context) error {
		close(started)
		<-release
		return nil
	}); err != nil {
		t.Fatalf("submit running job: %v", err)
	}
	awaitSignal(t, started, "first job to start")

	if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("submit queued job: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := p.Submit(ctx, func(context.Context) error { return nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked Submit error = %v, want context deadline exceeded", err)
	}

	close(release)
	shutdown(t, p)

	stats := p.Stats()
	if stats.Submitted != 2 || stats.Completed != 2 {
		t.Fatalf("stats after canceled submit = %+v, want 2 submitted and completed", stats)
	}
}

func TestShutdownDrainsQueuedJobs(t *testing.T) {
	p := New(2, 8)
	var ran atomic.Int64

	for i := 0; i < 8; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error {
			ran.Add(1)
			return nil
		}); err != nil {
			t.Fatalf("submit job %d: %v", i, err)
		}
	}

	shutdown(t, p)
	if got := ran.Load(); got != 8 {
		t.Fatalf("ran %d jobs, want all 8 queued jobs drained", got)
	}

	stats := p.Stats()
	if stats.Submitted != 8 || stats.Completed != 8 || stats.Failed != 0 || stats.Panicked != 0 {
		t.Fatalf("unexpected stats after drain: %+v", stats)
	}
}

func TestShutdownTimeoutCancelsInFlightJob(t *testing.T) {
	p := New(1, 1)
	started := make(chan struct{})
	canceled := make(chan struct{})

	if err := p.Submit(context.Background(), func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(canceled)
		return ctx.Err()
	}); err != nil {
		t.Fatalf("submit job: %v", err)
	}
	awaitSignal(t, started, "job to start")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := p.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown error = %v, want context deadline exceeded", err)
	}
	awaitSignal(t, canceled, "in-flight job context cancellation")

	shutdown(t, p)
	stats := p.Stats()
	if stats.Completed != 1 || stats.Failed != 1 {
		t.Fatalf("stats after canceled job = %+v, want one completed failure", stats)
	}
}

func TestDoubleShutdown(t *testing.T) {
	p := New(2, 2)
	shutdown(t, p)
	shutdown(t, p)
}

func TestConcurrentShutdown(t *testing.T) {
	p := New(2, 2)
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
			defer cancel()
			results <- p.Shutdown(ctx)
		}()
	}
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatalf("concurrent Shutdown error: %v", err)
		}
	}
}

func TestSubmitAfterShutdown(t *testing.T) {
	p := New(1, 1)
	shutdown(t, p)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.Submit(ctx, func(context.Context) error { return nil }); !errors.Is(err, ErrClosed) {
		t.Fatalf("Submit after Shutdown error = %v, want ErrClosed", err)
	}
}

func TestPanicRecoveryAndErrorCallback(t *testing.T) {
	p := New(1, 2)
	reported := make(chan error, 1)
	p.SetErrorHandler(func(err error) {
		reported <- err
	})

	if err := p.Submit(context.Background(), func(context.Context) error {
		panic("broken job")
	}); err != nil {
		t.Fatalf("submit panicking job: %v", err)
	}

	afterPanic := make(chan struct{})
	if err := p.Submit(context.Background(), func(context.Context) error {
		close(afterPanic)
		return nil
	}); err != nil {
		t.Fatalf("submit job after panic: %v", err)
	}

	shutdown(t, p)
	awaitSignal(t, afterPanic, "worker to continue after panic")

	select {
	case err := <-reported:
		if err == nil || !strings.Contains(err.Error(), "broken job") {
			t.Fatalf("reported panic error = %v, want panic value", err)
		}
	default:
		t.Fatal("panic was not reported to the error callback")
	}

	stats := p.Stats()
	if stats.Submitted != 2 || stats.Completed != 2 || stats.Failed != 0 || stats.Panicked != 1 {
		t.Fatalf("unexpected stats after panic: %+v", stats)
	}
}

func TestReturnedErrorIsReportedAndCounted(t *testing.T) {
	p := New(1, 1)
	want := errors.New("job failed")
	reported := make(chan error, 1)
	p.SetErrorHandler(func(err error) { reported <- err })

	if err := p.Submit(context.Background(), func(context.Context) error { return want }); err != nil {
		t.Fatalf("submit job: %v", err)
	}
	shutdown(t, p)

	select {
	case got := <-reported:
		if !errors.Is(got, want) {
			t.Fatalf("reported error = %v, want %v", got, want)
		}
	default:
		t.Fatal("returned job error was not reported")
	}

	stats := p.Stats()
	if stats.Submitted != 1 || stats.Completed != 1 || stats.Failed != 1 || stats.Panicked != 0 {
		t.Fatalf("unexpected stats after returned error: %+v", stats)
	}
}

func TestNoGoroutineLeakAfterShutdown(t *testing.T) {
	baseline := runtime.NumGoroutine()

	for i := 0; i < 10; i++ {
		p := New(4, 4)
		for j := 0; j < 4; j++ {
			if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
				t.Fatalf("pool %d submit: %v", i, err)
			}
		}
		shutdown(t, p)
	}

	deadline := time.Now().Add(testTimeout)
	for {
		runtime.GC()
		runtime.Gosched()
		got := runtime.NumGoroutine()
		if got <= baseline+3 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("goroutine count did not settle: before=%d after=%d", baseline, got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestNewRejectsInvalidSizes(t *testing.T) {
	for _, tc := range []struct {
		name      string
		workers   int
		queueSize int
	}{
		{name: "no workers", workers: 0, queueSize: 1},
		{name: "negative workers", workers: -1, queueSize: 1},
		{name: "empty queue", workers: 1, queueSize: 0},
		{name: "negative queue", workers: 1, queueSize: -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("New did not panic")
				}
			}()
			_ = New(tc.workers, tc.queueSize)
		})
	}
}

func shutdown(t *testing.T, p *Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if err := p.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

func awaitSignal(t *testing.T, ch <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(testTimeout):
		t.Fatalf("timed out waiting for %s", description)
	}
}
