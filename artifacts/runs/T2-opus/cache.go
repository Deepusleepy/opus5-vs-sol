// Package cache provides a capacity-bounded LRU cache with per-entry TTL and
// single-flight loading. It uses only the standard library and starts no
// background goroutines: expired entries are reclaimed lazily, on access.
package cache

import (
	"context"
	"sync"
	"time"
)

// Config configures a Cache.
type Config[K comparable, V any] struct {
	// Capacity is the maximum number of resident entries. Must be > 0.
	Capacity int

	// TTL is how long an entry stays valid after it is written. A value <= 0
	// means entries never expire.
	TTL time.Duration

	// OnEvict, if non-nil, is called after an entry leaves the cache: when it
	// is evicted to respect Capacity, when an expired entry is reclaimed, or
	// when it is removed by Delete. It is not called when a Put replaces the
	// value of a live key.
	//
	// OnEvict is always invoked without any internal lock held, so it may call
	// back into the cache.
	OnEvict func(key K, value V)

	// Now returns the current time. Nil means time.Now. It exists so tests can
	// drive expiry deterministically.
	Now func() time.Time
}

// Cache is a concurrency-safe LRU cache with per-entry TTL.
//
// The zero value is not usable; create one with New.
type Cache[K comparable, V any] struct {
	capacity int
	ttl      time.Duration
	now      func() time.Time
	onEvict  func(K, V)

	mu    sync.Mutex
	items map[K]*entry[K, V]
	root  entry[K, V] // sentinel: root.next is most-recently-used
	calls map[K]*call[V]
}

type entry[K comparable, V any] struct {
	key        K
	val        V
	expiresAt  time.Time // zero means "never expires"
	prev, next *entry[K, V]
}

// call tracks one in-flight load for a key.
type call[V any] struct {
	done chan struct{}

	// The fields below are written by the leader before done is closed and
	// read by waiters only after done is closed.
	val V
	err error
	// abandoned reports that the leader gave up because its own context was
	// cancelled. Waiters must retry rather than adopt the leader's error.
	abandoned bool
}

// New returns a Cache configured by cfg. It panics if cfg.Capacity <= 0.
func New[K comparable, V any](cfg Config[K, V]) *Cache[K, V] {
	if cfg.Capacity <= 0 {
		panic("cache: Capacity must be > 0")
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	c := &Cache[K, V]{
		capacity: cfg.Capacity,
		ttl:      cfg.TTL,
		now:      now,
		onEvict:  cfg.OnEvict,
		items:    make(map[K]*entry[K, V], cfg.Capacity),
		calls:    make(map[K]*call[V]),
	}
	c.root.next = &c.root
	c.root.prev = &c.root
	return c
}

// Get returns the value for key and whether it was present and unexpired.
// A hit marks the key as most-recently-used; an expired entry is reclaimed and
// reported as a miss, and does not affect LRU order.
func (c *Cache[K, V]) Get(key K) (V, bool) {
	var pending []entry[K, V]
	c.mu.Lock()
	v, ok := c.getLocked(key, &pending)
	c.mu.Unlock()
	c.notify(pending)
	return v, ok
}

// Put stores value under key, (re)starting its TTL, and marks it
// most-recently-used. If the cache is over capacity the least-recently-used
// entry is evicted.
func (c *Cache[K, V]) Put(key K, value V) {
	var pending []entry[K, V]
	c.mu.Lock()
	c.putLocked(key, value, &pending)
	c.mu.Unlock()
	c.notify(pending)
}

// Delete removes key, reporting whether an entry was removed. An expired but
// not-yet-reclaimed entry counts as removed.
func (c *Cache[K, V]) Delete(key K) bool {
	var pending []entry[K, V]
	c.mu.Lock()
	e, ok := c.items[key]
	if ok {
		c.removeLocked(e, &pending)
	}
	c.mu.Unlock()
	c.notify(pending)
	return ok
}

// Len returns the number of resident entries, including any that have expired
// but have not yet been reclaimed by an access.
func (c *Cache[K, V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items)
}

// GetOrLoad returns the cached value for key, or calls loader to produce it.
//
// Exactly one loader runs per key at a time: concurrent callers for the same
// key wait for the in-flight load and receive its result. Loader errors are
// never cached, so the next call retries.
//
// Cancellation: the leader passes its own ctx to loader. If the leader's ctx is
// cancelled and loader returns an error, the leader abandons the load instead
// of publishing the error, and the waiters retry — one of them becomes the new
// leader and drives the load with its own ctx. Waiters are therefore never
// stranded by the leader's cancellation, and a cancelled caller never poisons
// anyone else's result. The cost is that a cancelled load may be re-run.
//
// A caller whose own ctx is cancelled returns ctx.Err().
func (c *Cache[K, V]) GetOrLoad(ctx context.Context, key K, loader func(context.Context) (V, error)) (V, error) {
	var zero V
	for {
		if err := ctx.Err(); err != nil {
			return zero, err
		}

		var pending []entry[K, V]
		c.mu.Lock()
		v, ok := c.getLocked(key, &pending)
		if ok {
			c.mu.Unlock()
			c.notify(pending)
			return v, nil
		}
		inflight, waiting := c.calls[key]
		if !waiting {
			inflight = &call[V]{done: make(chan struct{})}
			c.calls[key] = inflight
		}
		c.mu.Unlock()
		c.notify(pending)

		if waiting {
			select {
			case <-ctx.Done():
				return zero, ctx.Err()
			case <-inflight.done:
				if inflight.abandoned {
					continue // leader's ctx died; retry, possibly as leader.
				}
				return inflight.val, inflight.err
			}
		}

		// This caller is the leader for key.
		v, err := loader(ctx)

		pending = nil
		c.mu.Lock()
		delete(c.calls, key)
		switch {
		case err != nil && ctx.Err() != nil:
			// Hand the load back to the waiters rather than sharing an error
			// that is really about this caller's cancellation.
			inflight.abandoned = true
		case err != nil:
			inflight.err = err
		default:
			inflight.val = v
			c.putLocked(key, v, &pending)
		}
		close(inflight.done)
		c.mu.Unlock()
		c.notify(pending)

		if err != nil {
			return zero, err
		}
		return v, nil
	}
}

// getLocked looks key up, reclaiming it if expired. Callers must hold c.mu.
func (c *Cache[K, V]) getLocked(key K, pending *[]entry[K, V]) (V, bool) {
	e, ok := c.items[key]
	if !ok {
		var zero V
		return zero, false
	}
	if c.expired(e) {
		c.removeLocked(e, pending)
		var zero V
		return zero, false
	}
	c.moveToFront(e)
	return e.val, true
}

// putLocked inserts or updates key. Callers must hold c.mu.
func (c *Cache[K, V]) putLocked(key K, value V, pending *[]entry[K, V]) {
	var expiresAt time.Time
	if c.ttl > 0 {
		expiresAt = c.now().Add(c.ttl)
	}
	if e, ok := c.items[key]; ok {
		e.val = value
		e.expiresAt = expiresAt
		c.moveToFront(e)
		return
	}
	e := &entry[K, V]{key: key, val: value, expiresAt: expiresAt}
	c.items[key] = e
	c.pushFront(e)
	for len(c.items) > c.capacity {
		c.removeLocked(c.root.prev, pending)
	}
}

// removeLocked unlinks e and queues its eviction callback. Callers must hold c.mu.
func (c *Cache[K, V]) removeLocked(e *entry[K, V], pending *[]entry[K, V]) {
	delete(c.items, e.key)
	e.prev.next = e.next
	e.next.prev = e.prev
	e.prev, e.next = nil, nil
	if c.onEvict != nil {
		*pending = append(*pending, *e)
	}
}

func (c *Cache[K, V]) expired(e *entry[K, V]) bool {
	return !e.expiresAt.IsZero() && !c.now().Before(e.expiresAt)
}

func (c *Cache[K, V]) pushFront(e *entry[K, V]) {
	e.prev = &c.root
	e.next = c.root.next
	e.prev.next = e
	e.next.prev = e
}

func (c *Cache[K, V]) moveToFront(e *entry[K, V]) {
	if c.root.next == e {
		return
	}
	e.prev.next = e.next
	e.next.prev = e.prev
	c.pushFront(e)
}

// notify runs eviction callbacks. It must be called with c.mu released.
func (c *Cache[K, V]) notify(pending []entry[K, V]) {
	for i := range pending {
		c.onEvict(pending[i].key, pending[i].val)
	}
}
