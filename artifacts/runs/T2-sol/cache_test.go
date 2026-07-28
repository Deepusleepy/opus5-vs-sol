package cache

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (f *fakeClock) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *fakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	f.mu.Unlock()
}

func TestLRUOrder(t *testing.T) {
	c := New[string, int](2, time.Hour)
	c.Set("a", 1)
	c.Set("b", 2)

	if got, ok := c.Get("a"); !ok || got != 1 {
		t.Fatalf("Get(a) = %v, %v; want 1, true", got, ok)
	}
	c.Set("c", 3)

	if _, ok := c.Get("b"); ok {
		t.Fatal("least-recently-used key b was not evicted")
	}
	if got, ok := c.Get("a"); !ok || got != 1 {
		t.Fatalf("recently used key a = %v, %v; want 1, true", got, ok)
	}
	if got, ok := c.Get("c"); !ok || got != 3 {
		t.Fatalf("new key c = %v, %v; want 3, true", got, ok)
	}
}

func TestTTLExpiryUsesWriteTime(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_000, 0)}
	c := New[string, int](2, 10*time.Second, WithClock[string, int](clock.Now))
	c.Set("a", 1)

	clock.Advance(9 * time.Second)
	if got, ok := c.Get("a"); !ok || got != 1 {
		t.Fatalf("before expiry Get(a) = %v, %v; want 1, true", got, ok)
	}

	// Reads do not extend TTL; expiration is measured from the write.
	clock.Advance(time.Second)
	if _, ok := c.Get("a"); ok {
		t.Fatal("entry was returned at its expiration boundary")
	}

	c.Set("a", 2)
	clock.Advance(9 * time.Second)
	c.Set("a", 3)
	clock.Advance(2 * time.Second)
	if got, ok := c.Get("a"); !ok || got != 3 {
		t.Fatalf("rewritten entry Get(a) = %v, %v; want 3, true", got, ok)
	}
}

func TestGetOrLoadSingleflightFanIn(t *testing.T) {
	const callers = 64
	c := New[string, int](4, time.Minute)
	start := make(chan struct{})
	entered := make(chan struct{}, callers)
	loaderStarted := make(chan struct{})
	release := make(chan struct{})
	var loads atomic.Int32

	loader := func(context.Context) (int, error) {
		if loads.Add(1) == 1 {
			close(loaderStarted)
		}
		<-release
		return 42, nil
	}

	results := make(chan int, callers)
	errs := make(chan error, callers)
	for i := 0; i < callers; i++ {
		go func() {
			<-start
			entered <- struct{}{}
			v, err := c.GetOrLoad(context.Background(), "key", loader)
			results <- v
			errs <- err
		}()
	}
	close(start)
	for i := 0; i < callers; i++ {
		<-entered
	}
	<-loaderStarted
	for i := 0; i < 100; i++ {
		runtime.Gosched()
	}
	close(release)

	for i := 0; i < callers; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("caller error = %v", err)
		}
		if got := <-results; got != 42 {
			t.Fatalf("caller value = %d; want 42", got)
		}
	}
	if got := loads.Load(); got != 1 {
		t.Fatalf("loader calls = %d; want 1", got)
	}
}

func TestLoaderErrorSharedAndNotCached(t *testing.T) {
	c := New[string, int](2, time.Minute)
	wantErr := errors.New("load failed")
	started := make(chan struct{})
	release := make(chan struct{})
	var loads atomic.Int32

	loader := func(context.Context) (int, error) {
		loads.Add(1)
		close(started)
		<-release
		return 0, wantErr
	}

	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() {
		_, err := c.GetOrLoad(context.Background(), "key", loader)
		first <- err
	}()
	<-started
	go func() {
		_, err := c.GetOrLoad(context.Background(), "key", loader)
		second <- err
	}()
	for i := 0; i < 100; i++ {
		runtime.Gosched()
	}
	close(release)

	if err := <-first; !errors.Is(err, wantErr) {
		t.Fatalf("loading caller error = %v; want %v", err, wantErr)
	}
	if err := <-second; !errors.Is(err, wantErr) {
		t.Fatalf("waiting caller error = %v; want %v", err, wantErr)
	}
	if got := loads.Load(); got != 1 {
		t.Fatalf("loader calls for shared error = %d; want 1", got)
	}

	got, err := c.GetOrLoad(context.Background(), "key", func(context.Context) (int, error) {
		loads.Add(1)
		return 7, nil
	})
	if err != nil || got != 7 {
		t.Fatalf("retry = %v, %v; want 7, nil", got, err)
	}
	if got := loads.Load(); got != 2 {
		t.Fatalf("loader calls after retry = %d; want 2", got)
	}
}

func TestCancelledLoaderHandsOffToWaiter(t *testing.T) {
	c := New[string, string](2, time.Minute)
	loadingCtx, cancel := context.WithCancel(context.Background())
	firstStarted := make(chan struct{})
	waiterEntering := make(chan struct{})
	var loads atomic.Int32

	loader := func(ctx context.Context) (string, error) {
		switch loads.Add(1) {
		case 1:
			close(firstStarted)
			<-ctx.Done()
			return "", ctx.Err()
		case 2:
			return "from waiter", nil
		default:
			return "", errors.New("unexpected extra load")
		}
	}

	firstResult := make(chan error, 1)
	go func() {
		_, err := c.GetOrLoad(loadingCtx, "key", loader)
		firstResult <- err
	}()
	<-firstStarted

	type result struct {
		value string
		err   error
	}
	waiterResult := make(chan result, 1)
	go func() {
		close(waiterEntering)
		value, err := c.GetOrLoad(context.Background(), "key", loader)
		waiterResult <- result{value: value, err: err}
	}()
	<-waiterEntering
	cancel()

	if err := <-firstResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled loading caller error = %v; want context.Canceled", err)
	}
	got := <-waiterResult
	if got.err != nil || got.value != "from waiter" {
		t.Fatalf("waiter result = %q, %v; want %q, nil", got.value, got.err, "from waiter")
	}
	if count := loads.Load(); count != 2 {
		t.Fatalf("loader calls = %d; want 2 (cancelled attempt plus handoff)", count)
	}
}

func TestEvictionCallbackCanReenterCache(t *testing.T) {
	callbackDone := make(chan struct{}, 1)
	var c *Cache[string, int]
	c = New[string, int](1, time.Hour, WithEvictionCallback[string, int](func(key string, value int) {
		if key != "old" || value != 1 {
			t.Errorf("evicted = %q, %d; want old, 1", key, value)
		}
		if got, ok := c.Get("new"); !ok || got != 2 {
			t.Errorf("reentrant Get(new) = %v, %v; want 2, true", got, ok)
		}
		callbackDone <- struct{}{}
	}))

	c.Set("old", 1)
	c.Set("new", 2)

	select {
	case <-callbackDone:
	case <-time.After(time.Second):
		t.Fatal("eviction callback deadlocked while re-entering cache")
	}
}
