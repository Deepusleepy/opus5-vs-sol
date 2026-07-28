package pool

import (
	"context"
	"errors"
	"runtime"
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
		t.Fatal(err)
	}
	wait(t, started)
	if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- p.Submit(ctx, func(context.Context) error { return nil })
	}()
	select {
	case err := <-result:
		t.Fatalf("Submit returned before cancellation: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	cancel()
	if err := waitValue(t, result); !errors.Is(err, context.Canceled) {
		t.Fatalf("Submit error = %v, want context.Canceled", err)
	}

	close(release)
	shutdown(t, p)
	if got := p.Stats().Submitted; got != 2 {
		t.Fatalf("Submitted = %d, want 2", got)
	}
}

func TestShutdownDrainsQueuedJobs(t *testing.T) {
	p := New(2, 8)
	var ran atomic.Int64
	for i := 0; i < 8; i++ {
		if err := p.Submit(context.Background(), func(context.Context) error {
			time.Sleep(time.Millisecond)
			ran.Add(1)
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	shutdown(t, p)

	if got := ran.Load(); got != 8 {
		t.Fatalf("ran = %d, want 8", got)
	}
	stats := p.Stats()
	if stats.Submitted != 8 || stats.Completed != 8 || stats.Failed != 0 || stats.Panicked != 0 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}

func TestShutdownTimeoutCancelsInflightJob(t *testing.T) {
	p := New(1, 1)
	started := make(chan struct{})
	canceled := make(chan struct{})
	if err := p.Submit(context.Background(), func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(canceled)
		return ctx.Err()
	}); err != nil {
		t.Fatal(err)
	}
	wait(t, started)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := p.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown error = %v, want context.DeadlineExceeded", err)
	}
	wait(t, canceled)
	shutdown(t, p)

	stats := p.Stats()
	if stats.Completed != 1 || stats.Failed != 1 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}

func TestDoubleShutdown(t *testing.T) {
	p := New(2, 2)
	shutdown(t, p)
	shutdown(t, p)
}

func TestSubmitAfterShutdown(t *testing.T) {
	p := New(1, 1)
	shutdown(t, p)
	if err := p.Submit(context.Background(), func(context.Context) error { return nil }); !errors.Is(err, ErrClosed) {
		t.Fatalf("Submit error = %v, want ErrClosed", err)
	}
}

func TestPanicRecoveryAndErrorReporting(t *testing.T) {
	p := New(1, 2)
	reports := make(chan error, 2)
	p.SetErrorHandler(func(err error) { reports <- err })
	ordinary := errors.New("ordinary failure")
	if err := p.Submit(context.Background(), func(context.Context) error { panic("boom") }); err != nil {
		t.Fatal(err)
	}
	if err := p.Submit(context.Background(), func(context.Context) error { return ordinary }); err != nil {
		t.Fatal(err)
	}
	shutdown(t, p)

	first := waitValue(t, reports)
	second := waitValue(t, reports)
	var panicErr *PanicError
	if !errors.As(first, &panicErr) && !errors.As(second, &panicErr) {
		t.Fatalf("reports %T and %T do not include *PanicError", first, second)
	}
	if len(panicErr.Stack) == 0 {
		t.Fatal("panic report has no stack trace")
	}
	if !errors.Is(first, ordinary) && !errors.Is(second, ordinary) {
		t.Fatalf("reports %v and %v do not include ordinary error", first, second)
	}
	stats := p.Stats()
	if stats.Submitted != 2 || stats.Completed != 2 || stats.Failed != 1 || stats.Panicked != 1 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}

func TestUnbufferedHandoff(t *testing.T) {
	p := New(1, 0)
	ran := make(chan struct{})
	if err := p.Submit(context.Background(), func(context.Context) error {
		close(ran)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	wait(t, ran)
	shutdown(t, p)
}

func TestNoGoroutineLeak(t *testing.T) {
	baseline := runtime.NumGoroutine()
	for i := 0; i < 40; i++ {
		p := New(3, 3)
		for j := 0; j < 6; j++ {
			if err := p.Submit(context.Background(), func(context.Context) error { return nil }); err != nil {
				t.Fatal(err)
			}
		}
		shutdown(t, p)
	}

	deadline := time.Now().Add(testTimeout)
	for runtime.NumGoroutine() > baseline+3 && time.Now().Before(deadline) {
		runtime.GC()
		time.Sleep(10 * time.Millisecond)
	}
	if got := runtime.NumGoroutine(); got > baseline+3 {
		t.Fatalf("goroutines after shutdown = %d, baseline = %d", got, baseline)
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

func wait(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for signal")
	}
}

func waitValue[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for value")
		var zero T
		return zero
	}
}
