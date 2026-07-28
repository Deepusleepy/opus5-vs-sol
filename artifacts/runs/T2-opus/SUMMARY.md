# T2 — `cache`: LRU + TTL + singleflight loading

## What I built

A single-file Go package (`cache.go`, standard library only) providing
`Cache[K comparable, V any]`:

- **LRU** — intrusive doubly-linked list plus a `map[K]*entry`, so lookup, touch,
  insert, and evict are all O(1). A sentinel node keeps the splice logic
  branch-free.
- **TTL** — each entry records an absolute `expiresAt` stamped at write time. A
  `TTL <= 0` means "never expires". Expiry is **lazy**: an expired entry found on
  access is unlinked, its eviction callback queued, and the access reported as a
  miss. It is not treated as an LRU hit, so a dead entry can never promote itself
  out of eviction range. **No background goroutines exist anywhere in the package.**
- **Singleflight `GetOrLoad`** — a `map[K]*call[V]` of in-flight loads. The first
  caller for a missing key becomes the leader and runs the loader; everyone else
  parks on the leader's `done` channel and takes its result. Errors are published
  to waiters but never written to the cache, so the next call retries.
- **Eviction callback** — `Config.OnEvict` fires for capacity eviction, lazy
  expiry reclamation, and `Delete`. It does **not** fire when a `Put` overwrites a
  live key.
- **Injectable clock** — `Config.Now` (defaults to `time.Now`) so tests advance
  time deterministically instead of sleeping.

Public surface is deliberately small: `New`, `Get`, `Put`, `Delete`, `Len`,
`GetOrLoad`.

## Design decision: cancelled loader → hand off to a waiter

The task asked me to pick a strategy and document it. **The leader passes its own
`ctx` to the loader; if that `ctx` is cancelled and the loader returns an error,
the leader marks the flight `abandoned` instead of publishing the error.** Waiters
woken on an abandoned flight loop and retry — the first one back through
`GetOrLoad` becomes the new leader and drives the load with its own context.

Why this over the alternatives:

- *Detaching the load onto `context.Background()`* keeps waiters served, but needs
  a goroutine that outlives every caller, which the no-background-goroutines
  constraint rules out; it also lets a load keep running after everyone who wanted
  it has gone.
- *Publishing the leader's `context.Canceled` to all waiters* is the naive
  behaviour and is exactly the stranded-waiter failure: one caller pressing Ctrl-C
  poisons N unrelated callers with an error about a context they never passed in.

The cost is worth stating plainly: **a cancelled load may be re-executed**, so
loaders should be idempotent (they should be anyway — nothing guarantees a load
isn't racing an eviction). A caller whose *own* ctx is cancelled always gets
`ctx.Err()` and never waits.

`TestCancelledLeaderHandsOffToWaiter` covers this end to end, including the
negative: while the leader's flight is live, the waiter has *not* started a load
of its own.

## Locking and the eviction callback

One `sync.Mutex` guards the map, the list, and the in-flight table. Callbacks are
never invoked under it: every mutating path appends the departing entries to a
local `pending` slice, releases the lock, then runs `OnEvict`. Re-entrancy is
therefore safe by construction rather than by convention.

`TestEvictionCallbackIsReentrant` proves it — the callback calls `Get`, `Delete`,
`Len`, `Put`, and `GetOrLoad` back into the same cache, on both the
capacity-eviction and the lazy-expiry path. Under a callback-under-lock
implementation this test deadlocks rather than fails, which is why it is written
as a real re-entrant call and not a lock-state assertion.

`pending` holds a *copy* of each entry's key and value, so the callback observes
the evicted value even if the entry struct is reused.

## Tests

No test sleeps to make time pass or to order events. Time is driven by the fake
clock; concurrency is ordered by channels and by a small `gateCtx` helper whose
`Done()` reports the exact moment a caller is about to park on an in-flight load.
That is what makes the fan-in count (exactly 1 loader invocation across 65
concurrent callers) a real assertion rather than a hopeful one.

| Test | Covers |
| --- | --- |
| `TestLRUOrderAndEviction` | LRU order, touch-on-hit, overwrite refreshes recency |
| `TestTTLExpiry` | expiry at the deadline, write restarts TTL, reclamation shrinks `Len` |
| `TestExpiredEntryIsNotAnLRUHit` | expired read must not count as a hit |
| `TestGetOrLoadCachesAndReloadsAfterExpiry` | value cached, reloaded once expired |
| `TestSingleflightFanIn` | 64 waiters + 1 leader, loader runs **exactly once** |
| `TestLoaderErrorIsNotCachedAndWaitersSeeIt` | waiters get the error, nothing cached, retry succeeds |
| `TestCancelledLeaderHandsOffToWaiter` | cancelled-leader handoff |
| `TestCallerCancellationReturnsCtxErr` | a caller's own cancellation returns `ctx.Err()` |
| `TestEvictionCallbackIsReentrant` | callback re-enters the cache; no lock held |
| `TestDelete` | delete semantics + callback |
| `TestConcurrentMixedWorkloadRace` | 16 goroutines x 200 mixed ops for the race detector |

## How to verify

```
go vet ./...
go test -race ./...
gofmt -l .        # no output
```

Output tail of `go test -race -v ./...`:

```
=== CONT  TestLRUOrderAndEviction
=== CONT  TestLoaderErrorIsNotCachedAndWaitersSeeIt
=== CONT  TestEvictionCallbackIsReentrant
=== CONT  TestGetOrLoadCachesAndReloadsAfterExpiry
=== CONT  TestSingleflightFanIn
--- PASS: TestCancelledLeaderHandsOffToWaiter (0.00s)
--- PASS: TestLoaderErrorIsNotCachedAndWaitersSeeIt (0.00s)
--- PASS: TestCallerCancellationReturnsCtxErr (0.00s)
--- PASS: TestExpiredEntryIsNotAnLRUHit (0.00s)
--- PASS: TestLRUOrderAndEviction (0.00s)
--- PASS: TestGetOrLoadCachesAndReloadsAfterExpiry (0.00s)
--- PASS: TestEvictionCallbackIsReentrant (0.00s)
--- PASS: TestSingleflightFanIn (0.00s)
--- PASS: TestConcurrentMixedWorkloadRace (0.00s)
PASS
ok  	cache	1.187s
```

Also green under `go test -race -count=3 ./...`.

## Known limitations

- **A cancelled load can be re-run.** Direct consequence of the handoff choice
  above; loaders should be idempotent.
- **Expiry is lazy, so memory is not reclaimed until touched.** An entry that
  expires and is never accessed again occupies a slot until capacity pressure
  evicts it. Forced by the no-background-goroutines constraint, and the right
  trade here: the bound is on entry count, and it still holds.
- **`Len()` counts expired-but-unreclaimed entries.** Documented on the method;
  reporting the live count would require an O(n) scan.
- **One global mutex.** Fine well past millions of ops/sec on a single cache. A
  shard-per-key-hash split would be the next step under heavier contention, but
  nothing asked for it and it would complicate the LRU bound across shards.
- **An eviction callback that itself causes evictions can recurse.** The cache
  imposes no depth limit; the callback runs lock-free so the cache stays
  consistent, but a callback that unconditionally writes on every eviction will
  recurse. The re-entrancy test caps its own depth for exactly this reason.
- **`OnEvict` runs synchronously on the calling goroutine.** A slow callback slows
  that caller; callers wanting async should hand off to their own goroutine.
