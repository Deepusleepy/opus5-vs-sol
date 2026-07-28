# T2 — Go: LRU cache with TTL and singleflight loading

Implement a package `cache` in Go (standard library only).

Requirements:
- Generic `Cache[K comparable, V any]` with capacity-bounded LRU eviction and per-entry TTL (entry expires TTL after write; expired entries must never be returned and must not count as LRU hits).
- `GetOrLoad(ctx context.Context, key K, loader func(context.Context) (V, error)) (V, error)`: on miss, exactly ONE loader runs per key across concurrent callers (singleflight); other callers for the same key wait and receive the same result. A loader error must NOT be cached; waiting callers receive that error, and the next call retries.
- If the loading caller's ctx is cancelled, waiters must not be stranded: either another waiter's ctx drives the load or the load is handed off — document your choice and test it.
- Eviction callback support; must not be invoked while holding internal locks (prove with a test that re-enters the cache from the callback).
- Correct under `go test -race`. No background goroutines allowed (expiry is lazy on access).

Deliverables in this directory only:
- `go.mod` (module `cache`), implementation, tests covering: LRU order, TTL expiry (use injectable clock, no time.Sleep loops), singleflight fan-in (N concurrent callers, count loader invocations), error-not-cached retry, cancelled-loader handoff, re-entrant eviction callback.
- All tests green under `go test -race ./...`; include output tail in SUMMARY.md.
- `SUMMARY.md` as in T1. No AI model names anywhere. Simplicity counts; speculative features count against you.
