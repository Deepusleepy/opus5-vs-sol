package cache

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock is an injectable, deterministic clock. Tests never sleep to make
// time pass; they call Advance.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock {
	return &fakeClock{t: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// gateCtx reports the moment GetOrLoad first consults ctx.Done(), which for a
// waiting caller is exactly when it has registered itself and is about to block
// on the in-flight load. It lets the tests order events without sleeping.
type gateCtx struct {
	context.Context
	once   sync.Once
	waited chan struct{}
}

func newGateCtx(parent context.Context) *gateCtx {
	return &gateCtx{Context: parent, waited: make(chan struct{})}
}

func (g *gateCtx) Done() <-chan struct{} {
	g.once.Do(func() { close(g.waited) })
	return g.Context.Done()
}

func recv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		panic("unreachable")
	}
}

func TestLRUOrderAndEviction(t *testing.T) {
	t.Parallel()

	var evicted []string
	c := New(Config[string, int]{
		Capacity: 2,
		OnEvict:  func(k string, v int) { evicted = append(evicted, fmt.Sprintf("%s=%d", k, v)) },
	})

	c.Put("a", 1)
	c.Put("b", 2)

	// Touching "a" makes "b" the least-recently-used entry.
	if v, ok := c.Get("a"); !ok || v != 1 {
		t.Fatalf("Get(a) = %v, %v; want 1, true", v, ok)
	}
	c.Put("c", 3)

	if _, ok := c.Get("b"); ok {
		t.Error("b should have been evicted as least-recently-used")
	}
	if v, ok := c.Get("a"); !ok || v != 1 {
		t.Errorf("Get(a) = %v, %v; want 1, true", v, ok)
	}
	if v, ok := c.Get("c"); !ok || v != 3 {
		t.Errorf("Get(c) = %v, %v; want 3, true", v, ok)
	}
	if got, want := evicted, []string{"b=2"}; len(got) != 1 || got[0] != want[0] {
		t.Errorf("evicted = %v; want %v", got, want)
	}

	// Overwriting a live key updates it in place and refreshes recency.
	c.Put("a", 10)
	if got := c.Len(); got != 2 {
		t.Errorf("Len() = %d; want 2", got)
	}
	c.Put("d", 4) // evicts "c"
	if _, ok := c.Get("c"); ok {
		t.Error("c should have been evicted")
	}
	if v, ok := c.Get("a"); !ok || v != 10 {
		t.Errorf("Get(a) = %v, %v; want 10, true", v, ok)
	}
}

func TestTTLExpiry(t *testing.T) {
	t.Parallel()

	clk := newClock()
	var evicted []string
	c := New(Config[string, int]{
		Capacity: 2,
		TTL:      100 * time.Millisecond,
		Now:      clk.Now,
		OnEvict:  func(k string, v int) { evicted = append(evicted, k) },
	})

	c.Put("a", 1)
	clk.Advance(50 * time.Millisecond)
	c.Put("b", 2)

	clk.Advance(50 * time.Millisecond) // a is exactly at its deadline, b is not.
	if _, ok := c.Get("a"); ok {
		t.Error("a should be expired at its deadline")
	}
	if v, ok := c.Get("b"); !ok || v != 2 {
		t.Errorf("Get(b) = %v, %v; want 2, true", v, ok)
	}
	if got := c.Len(); got != 1 {
		t.Errorf("Len() = %d; want 1 (expired entry should be reclaimed)", got)
	}
	if len(evicted) != 1 || evicted[0] != "a" {
		t.Errorf("evicted = %v; want [a]", evicted)
	}

	// A write restarts the TTL.
	c.Put("b", 3)
	clk.Advance(99 * time.Millisecond)
	if v, ok := c.Get("b"); !ok || v != 3 {
		t.Errorf("Get(b) = %v, %v; want 3, true", v, ok)
	}
	clk.Advance(time.Millisecond)
	if _, ok := c.Get("b"); ok {
		t.Error("b should be expired")
	}
}

// An expired entry must not be treated as a hit, so it must not save itself
// from eviction by being "recently accessed".
func TestExpiredEntryIsNotAnLRUHit(t *testing.T) {
	t.Parallel()

	clk := newClock()
	c := New(Config[string, int]{Capacity: 2, TTL: 100 * time.Millisecond, Now: clk.Now})

	c.Put("a", 1)
	clk.Advance(150 * time.Millisecond)
	c.Put("b", 2) // a is expired but still resident.

	if _, ok := c.Get("a"); ok { // would be an LRU touch if it were a hit
		t.Fatal("a should be expired")
	}
	c.Put("c", 3)

	// If the expired read had counted as a hit, "b" would have been evicted.
	if v, ok := c.Get("b"); !ok || v != 2 {
		t.Errorf("Get(b) = %v, %v; want 2, true", v, ok)
	}
	if _, ok := c.Get("a"); ok {
		t.Error("a should be gone")
	}
}

func TestGetOrLoadCachesAndReloadsAfterExpiry(t *testing.T) {
	t.Parallel()

	clk := newClock()
	c := New(Config[string, int]{Capacity: 2, TTL: 100 * time.Millisecond, Now: clk.Now})

	var calls atomic.Int32
	load := func(context.Context) (int, error) {
		return int(calls.Add(1)), nil
	}

	for i := 0; i < 3; i++ {
		v, err := c.GetOrLoad(context.Background(), "k", load)
		if err != nil || v != 1 {
			t.Fatalf("GetOrLoad = %v, %v; want 1, nil", v, err)
		}
	}
	clk.Advance(100 * time.Millisecond)
	v, err := c.GetOrLoad(context.Background(), "k", load)
	if err != nil || v != 2 {
		t.Fatalf("after expiry GetOrLoad = %v, %v; want 2, nil", v, err)
	}
	if got := calls.Load(); got != 2 {
		t.Errorf("loader ran %d times; want 2", got)
	}
}

func TestSingleflightFanIn(t *testing.T) {
	t.Parallel()

	const waiters = 64

	c := New(Config[string, int]{Capacity: 8})

	var loads atomic.Int32
	release := make(chan struct{})
	leaderIn := make(chan struct{})

	leaderLoad := func(context.Context) (int, error) {
		loads.Add(1)
		close(leaderIn)
		<-release
		return 42, nil
	}
	waiterLoad := func(context.Context) (int, error) {
		loads.Add(1)
		return -1, nil
	}

	type result struct {
		v   int
		err error
	}
	results := make(chan result, waiters+1)

	go func() {
		v, err := c.GetOrLoad(context.Background(), "k", leaderLoad)
		results <- result{v, err}
	}()
	// Once the leader is inside its (blocked) loader, every other caller for
	// the same key is guaranteed to fan in rather than start its own load.
	recv(t, leaderIn, "leader loader to start")

	var wg sync.WaitGroup
	registered := make(chan struct{}, waiters)
	for i := 0; i < waiters; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx := newGateCtx(context.Background())
			go func() {
				<-ctx.waited
				registered <- struct{}{}
			}()
			v, err := c.GetOrLoad(ctx, "k", waiterLoad)
			results <- result{v, err}
		}()
	}
	for i := 0; i < waiters; i++ {
		recv(t, registered, "waiter to block on the in-flight load")
	}

	close(release)
	wg.Wait()

	for i := 0; i < waiters+1; i++ {
		r := recv(t, results, "caller result")
		if r.err != nil || r.v != 42 {
			t.Fatalf("caller got %v, %v; want 42, nil", r.v, r.err)
		}
	}
	if got := loads.Load(); got != 1 {
		t.Errorf("loader ran %d times; want exactly 1", got)
	}
	if v, ok := c.Get("k"); !ok || v != 42 {
		t.Errorf("Get(k) = %v, %v; want 42, true", v, ok)
	}
}

func TestLoaderErrorIsNotCachedAndWaitersSeeIt(t *testing.T) {
	t.Parallel()

	c := New(Config[string, int]{Capacity: 4})
	wantErr := errors.New("boom")

	var loads atomic.Int32
	release := make(chan struct{})
	leaderIn := make(chan struct{})
	failing := func(context.Context) (int, error) {
		loads.Add(1)
		close(leaderIn)
		<-release
		return 0, wantErr
	}

	errs := make(chan error, 2)
	go func() {
		_, err := c.GetOrLoad(context.Background(), "k", failing)
		errs <- err
	}()
	recv(t, leaderIn, "leader loader to start")

	ctx := newGateCtx(context.Background())
	go func() {
		_, err := c.GetOrLoad(ctx, "k", func(context.Context) (int, error) {
			loads.Add(1)
			return 0, errors.New("waiter should not load")
		})
		errs <- err
	}()
	<-ctx.waited
	close(release)

	for i := 0; i < 2; i++ {
		if err := recv(t, errs, "caller result"); !errors.Is(err, wantErr) {
			t.Fatalf("err = %v; want %v", err, wantErr)
		}
	}
	if got := loads.Load(); got != 1 {
		t.Errorf("loader ran %d times; want 1", got)
	}
	if _, ok := c.Get("k"); ok {
		t.Error("a loader error must not be cached")
	}

	// The next call retries and can succeed.
	v, err := c.GetOrLoad(context.Background(), "k", func(context.Context) (int, error) {
		return 7, nil
	})
	if err != nil || v != 7 {
		t.Fatalf("retry = %v, %v; want 7, nil", v, err)
	}
}

// When the caller that is running the load has its context cancelled, the
// waiters must not be stranded or handed the leader's cancellation error: one
// of them takes over and drives the load with its own context.
func TestCancelledLeaderHandsOffToWaiter(t *testing.T) {
	t.Parallel()

	c := New(Config[string, int]{Capacity: 4})

	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	defer cancelLeader()

	leaderIn := make(chan struct{})
	leaderErr := make(chan error, 1)
	go func() {
		_, err := c.GetOrLoad(leaderCtx, "k", func(ctx context.Context) (int, error) {
			close(leaderIn)
			<-ctx.Done()
			return 0, ctx.Err()
		})
		leaderErr <- err
	}()
	recv(t, leaderIn, "leader loader to start")

	waiterCtx := newGateCtx(context.Background())
	waiterLoaded := make(chan struct{})
	waiterResult := make(chan int, 1)
	go func() {
		v, err := c.GetOrLoad(waiterCtx, "k", func(context.Context) (int, error) {
			close(waiterLoaded)
			return 99, nil
		})
		if err != nil {
			t.Errorf("waiter got error %v; want nil", err)
		}
		waiterResult <- v
	}()
	// The waiter is now parked on the leader's load; the leader still holds the
	// single flight, so the waiter cannot have started a load of its own.
	<-waiterCtx.waited
	select {
	case <-waiterLoaded:
		t.Fatal("waiter started its own load while a load was in flight")
	default:
	}

	cancelLeader()

	if err := recv(t, leaderErr, "leader result"); !errors.Is(err, context.Canceled) {
		t.Errorf("leader err = %v; want context.Canceled", err)
	}
	recv(t, waiterLoaded, "waiter to take over the load")
	if v := recv(t, waiterResult, "waiter result"); v != 99 {
		t.Errorf("waiter got %d; want 99", v)
	}
	if v, ok := c.Get("k"); !ok || v != 99 {
		t.Errorf("Get(k) = %v, %v; want 99, true", v, ok)
	}
}

func TestCallerCancellationReturnsCtxErr(t *testing.T) {
	t.Parallel()

	c := New(Config[string, int]{Capacity: 4})

	leaderIn := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	go func() {
		_, _ = c.GetOrLoad(context.Background(), "k", func(context.Context) (int, error) {
			close(leaderIn)
			<-release
			return 1, nil
		})
	}()
	recv(t, leaderIn, "leader loader to start")

	ctx, cancel := context.WithCancel(context.Background())
	errs := make(chan error, 1)
	gate := newGateCtx(ctx)
	go func() {
		_, err := c.GetOrLoad(gate, "k", func(context.Context) (int, error) {
			return 0, errors.New("must not run")
		})
		errs <- err
	}()
	<-gate.waited
	cancel()

	if err := recv(t, errs, "waiter result"); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v; want context.Canceled", err)
	}
}

// The eviction callback must run without any internal lock held, so it is free
// to call back into the cache. If a lock were held this test would deadlock.
func TestEvictionCallbackIsReentrant(t *testing.T) {
	t.Parallel()

	clk := newClock()
	var c *Cache[string, int]

	var mu sync.Mutex
	var seen []string
	var depth int

	c = New(Config[string, int]{
		Capacity: 4,
		TTL:      100 * time.Millisecond,
		Now:      clk.Now,
		OnEvict: func(k string, v int) {
			mu.Lock()
			seen = append(seen, k)
			nested := depth
			depth++
			mu.Unlock()
			defer func() {
				mu.Lock()
				depth--
				mu.Unlock()
			}()
			if nested > 0 {
				// Only re-enter at the top level; the nested calls below can
				// themselves evict, and unbounded recursion is the test's
				// problem, not the cache's.
				return
			}
			// Re-enter the cache from inside the callback along every public
			// path. If any internal lock were held here, this would deadlock.
			c.Get(k)
			c.Delete(k)
			_ = c.Len()
			c.Put("touched", v)
			_, _ = c.GetOrLoad(context.Background(), "loaded", func(context.Context) (int, error) {
				return v * 2, nil
			})
		},
	})

	// Capacity-driven eviction.
	for _, k := range []string{"a", "b", "c", "d"} {
		c.Put(k, 1)
	}
	c.Put("e", 5) // evicts "a"

	mu.Lock()
	got := append([]string(nil), seen...)
	seen = nil
	mu.Unlock()
	if !contains(got, "a") {
		t.Fatalf("evictions = %v; want it to include a", got)
	}
	if v, ok := c.Get("touched"); !ok || v != 1 {
		t.Errorf("Get(touched) = %v, %v; want 1, true (callback write must land)", v, ok)
	}

	// Expiry-driven reclamation runs the callback the same way.
	clk.Advance(200 * time.Millisecond)
	if _, ok := c.Get("e"); ok {
		t.Error("e should be expired")
	}
	mu.Lock()
	got = append([]string(nil), seen...)
	mu.Unlock()
	if !contains(got, "e") {
		t.Errorf("expiry evictions = %v; want it to include e", got)
	}
}

func contains(s []string, want string) bool {
	for _, v := range s {
		if v == want {
			return true
		}
	}
	return false
}

func TestDelete(t *testing.T) {
	t.Parallel()

	evicted := make(chan string, 2)
	c := New(Config[string, int]{
		Capacity: 4,
		OnEvict:  func(k string, v int) { evicted <- k },
	})

	c.Put("a", 1)
	if !c.Delete("a") {
		t.Error("Delete(a) = false; want true")
	}
	if c.Delete("a") {
		t.Error("Delete(a) on a missing key = true; want false")
	}
	if got := recv(t, evicted, "eviction callback"); got != "a" {
		t.Errorf("evicted %q; want a", got)
	}
	if got := c.Len(); got != 0 {
		t.Errorf("Len() = %d; want 0", got)
	}
}

// A broad concurrent workload, mainly to give the race detector something to
// chew on across all code paths at once.
func TestConcurrentMixedWorkloadRace(t *testing.T) {
	t.Parallel()

	clk := newClock()
	var evictions atomic.Int64
	c := New(Config[int, int]{
		Capacity: 16,
		TTL:      10 * time.Millisecond,
		Now:      clk.Now,
		OnEvict:  func(k, v int) { evictions.Add(1) },
	})

	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				k := (g*7 + i) % 32
				switch i % 4 {
				case 0:
					c.Put(k, i)
				case 1:
					c.Get(k)
				case 2:
					c.Delete(k)
				case 3:
					_, _ = c.GetOrLoad(context.Background(), k, func(context.Context) (int, error) {
						if k%5 == 0 {
							return 0, errors.New("nope")
						}
						return k, nil
					})
				}
				if i%50 == 0 {
					clk.Advance(3 * time.Millisecond)
				}
			}
		}(g)
	}
	wg.Wait()

	if got := c.Len(); got > 16 {
		t.Errorf("Len() = %d; want <= 16", got)
	}
	if evictions.Load() == 0 {
		t.Error("expected some evictions during the mixed workload")
	}
}
