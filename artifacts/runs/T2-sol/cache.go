// Package cache provides a capacity-bounded LRU cache with per-entry TTLs
// and singleflight loading.
package cache

import (
	"container/list"
	"context"
	"errors"
	"sync"
	"time"
)

// Option configures a Cache.
type Option[K comparable, V any] func(*Cache[K, V])

// WithClock replaces the clock used to calculate and check expiration times.
// It is primarily useful for deterministic tests.
func WithClock[K comparable, V any](now func() time.Time) Option[K, V] {
	if now == nil {
		panic("cache: nil clock")
	}
	return func(c *Cache[K, V]) { c.now = now }
}

// WithEvictionCallback registers a function called after an entry is removed
// because it expired or was displaced by capacity pressure. The callback is
// never called while the cache's internal mutex is held.
func WithEvictionCallback[K comparable, V any](fn func(K, V)) Option[K, V] {
	return func(c *Cache[K, V]) { c.onEvict = fn }
}

// Cache is a concurrency-safe, capacity-bounded LRU cache. Expiration is lazy:
// entries are checked on access and no cleanup goroutine is started.
type Cache[K comparable, V any] struct {
	mu       sync.Mutex
	capacity int
	ttl      time.Duration
	now      func() time.Time
	onEvict  func(K, V)
	items    map[K]*list.Element
	lru      list.List
	flights  map[K]*flight[V]
}

type entry[K comparable, V any] struct {
	key       K
	value     V
	expiresAt time.Time
}

type flight[V any] struct {
	done  chan struct{}
	value V
	err   error
	retry bool
}

type evicted[K comparable, V any] struct {
	key   K
	value V
}

// New constructs a cache. Capacity must be positive. A non-positive TTL is
// allowed and causes writes to be immediately expired.
func New[K comparable, V any](capacity int, ttl time.Duration, opts ...Option[K, V]) *Cache[K, V] {
	if capacity <= 0 {
		panic("cache: capacity must be positive")
	}
	c := &Cache[K, V]{
		capacity: capacity,
		ttl:      ttl,
		now:      time.Now,
		items:    make(map[K]*list.Element, capacity),
		flights:  make(map[K]*flight[V]),
	}
	for _, opt := range opts {
		if opt == nil {
			panic("cache: nil option")
		}
		opt(c)
	}
	return c
}

// Get returns an unexpired value and marks it as most recently used. Expired
// entries are removed and are not counted as hits.
func (c *Cache[K, V]) Get(key K) (V, bool) {
	c.mu.Lock()
	value, ok, removed := c.getLocked(key, c.now())
	c.mu.Unlock()
	c.notify(removed)
	return value, ok
}

// Set stores value with a fresh TTL measured from this write and marks it most
// recently used.
func (c *Cache[K, V]) Set(key K, value V) {
	c.mu.Lock()
	removed := c.setLocked(key, value, c.now())
	c.mu.Unlock()
	c.notify(removed)
}

// Len returns the number of entries currently stored. Because expiry is lazy,
// it may include expired entries that have not subsequently been accessed.
func (c *Cache[K, V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items)
}

// GetOrLoad returns a cached value or calls loader on a miss. At most one
// loader runs for a key at a time; concurrent callers wait for its result.
// Loader errors are shared by current waiters but are never cached.
//
// The loader runs synchronously in the caller that won the flight, using that
// caller's context; Cache starts no goroutines. If that context is cancelled
// and the loader returns an error, the flight is handed off: current waiters
// retry, and one of their contexts drives a new loader invocation. Thus a
// cancelled loading caller cannot strand callers whose contexts remain live.
func (c *Cache[K, V]) GetOrLoad(
	ctx context.Context,
	key K,
	loader func(context.Context) (V, error),
) (V, error) {
	if loader == nil {
		panic("cache: nil loader")
	}

	for {
		if err := ctx.Err(); err != nil {
			var zero V
			return zero, err
		}

		c.mu.Lock()
		value, ok, removed := c.getLocked(key, c.now())
		if ok {
			c.mu.Unlock()
			c.notify(removed)
			return value, nil
		}
		if f, exists := c.flights[key]; exists {
			c.mu.Unlock()
			c.notify(removed)

			select {
			case <-f.done:
				if f.retry {
					continue
				}
				return f.value, f.err
			case <-ctx.Done():
				var zero V
				return zero, ctx.Err()
			}
		}

		f := &flight[V]{done: make(chan struct{})}
		c.flights[key] = f
		c.mu.Unlock()
		c.notify(removed)

		loaded, err := loader(ctx)

		c.mu.Lock()
		if err != nil && ctx.Err() != nil && errors.Is(err, ctx.Err()) {
			// Cancellation errors are not broadcast as a terminal flight result:
			// live waiters compete to continue the load with their own context.
			f.retry = true
			f.err = err
			delete(c.flights, key)
			close(f.done)
			c.mu.Unlock()
			var zero V
			return zero, err
		}

		var displaced []evicted[K, V]
		f.value, f.err = loaded, err
		if err == nil {
			displaced = c.setLocked(key, loaded, c.now())
		}
		delete(c.flights, key)
		close(f.done)
		c.mu.Unlock()
		c.notify(displaced)
		return loaded, err
	}
}

func (c *Cache[K, V]) getLocked(key K, now time.Time) (V, bool, []evicted[K, V]) {
	elem, ok := c.items[key]
	if !ok {
		var zero V
		return zero, false, nil
	}
	e := elem.Value.(*entry[K, V])
	if !now.Before(e.expiresAt) {
		c.removeLocked(elem)
		var zero V
		return zero, false, []evicted[K, V]{{key: e.key, value: e.value}}
	}
	c.lru.MoveToFront(elem)
	return e.value, true, nil
}

func (c *Cache[K, V]) setLocked(key K, value V, now time.Time) []evicted[K, V] {
	var removed []evicted[K, V]
	if elem, ok := c.items[key]; ok {
		old := elem.Value.(*entry[K, V])
		old.value = value
		old.expiresAt = now.Add(c.ttl)
		c.lru.MoveToFront(elem)
	} else {
		e := &entry[K, V]{key: key, value: value, expiresAt: now.Add(c.ttl)}
		c.items[key] = c.lru.PushFront(e)
	}

	if c.lru.Len() > c.capacity {
		elem := c.lru.Back()
		e := elem.Value.(*entry[K, V])
		c.removeLocked(elem)
		removed = append(removed, evicted[K, V]{key: e.key, value: e.value})
	}
	return removed
}

func (c *Cache[K, V]) removeLocked(elem *list.Element) {
	e := elem.Value.(*entry[K, V])
	delete(c.items, e.key)
	c.lru.Remove(elem)
}

func (c *Cache[K, V]) notify(entries []evicted[K, V]) {
	if c.onEvict == nil {
		return
	}
	for _, e := range entries {
		c.onEvict(e.key, e.value)
	}
}
