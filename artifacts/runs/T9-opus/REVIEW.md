# Review — `sessionstore.go` and `budget.ts`

Defects ranked most-severe first. Line numbers refer to the files as given.

---

## 1. `sessionstore.go:46-48` — BLOCKER — map is written under a *read* lock, so concurrent `NewSession` calls corrupt the map

`NewSession` takes `s.mu.RLock()` and then performs `s.sessions[id] = sess`, a write. `RLock` is shared, so any number of goroutines can be inside that critical section simultaneously.

**Failure scenario:** two HTTP handlers call `NewSession("acme")` at the same time. Both hold `RLock`, both assign into `s.sessions`. Go's runtime map-race detector fires `fatal error: concurrent map writes` and the process dies — unrecoverable, no defer can catch it. Even without a simultaneous second writer, a concurrent `Snapshot` (also `RLock`) can read the map mid-write and observe a torn bucket.

**Fix:** use the write lock.
```go
s.mu.Lock()
s.sessions[id] = sess
s.mu.Unlock()
```

---

## 2. `sessionstore.go:88-92` (with `journal` at 135-143) — BLOCKER — purging a session *rewrites* its journal file instead of removing it, so purged sessions come back after a restart

`journal` ignores its `op` argument entirely: for every op it marshals the session and writes it to `<dir>/<id>.json`. The `"purge"` call therefore re-persists the very session that was just evicted. Nothing ever deletes a file.

**Failure scenario:** a session goes idle, `Purge()` removes it from the map and journals `"purge"`, which (re)writes `s-1a2b3c4d.json`. The process restarts; `Replay()` reads that file and reinserts the session. Bounded-memory intent is broken — the disk directory and the post-restart map grow without limit and never shrink, and users see resurrected dead sessions in the list.

**Fix:** give purge its own path rather than routing it through `journal`:
```go
os.Remove(filepath.Join(s.dir, sess.ID+".json"))
```
(or write a real tombstone record that `Replay` honours).

---

## 3. `budget.ts:48-60` — BLOCKER — `canSpend`/`addSpend` is a check-then-act with no atomicity, so brands overspend the limit

Both methods `await this.load()`, which yields to the event loop. Nothing reserves the amount between the check and the record, and `addSpend` re-checks nothing.

**Failure scenario:** limit 50, spent 49. Ten concurrent requests each costing 5 all call `canSpend(5)`; every one evaluates `49 + 5 < 50` → false. Take spent 40 instead: all ten see `40 + 5 < 50` → true, all ten proceed, all ten call `addSpend(5)`, final spent = 90 on a limit of 50. The stated invariant ("a brand must NEVER exceed its monthly limit") is violated by a factor of nearly 2.

**Fix:** collapse the two into one reserve operation that checks and increments without an intervening `await`, and have callers refund on failure:
```ts
async tryReserve(amount: number): Promise<boolean> {
  const state = await this.load();
  this.rollIfNeeded(state);
  if (state.spent + amount > state.limit) return false;
  state.spent += amount;      // no await between check and mutate
  this.persist();
  return true;
}
```

---

## 4. `budget.ts:29-36` — BLOCKER — a bare `catch` treats *any* read or parse failure as "first run", silently zeroing spend and resetting the limit to 50

`load()` catches everything from `readFile` and `JSON.parse` and substitutes a default state with `spent: 0, limit: 50`. That default is then persisted by the next `addSpend`/`setLimit`, destroying the real record.

**Failure scenario:** a brand has `limit: 5000, spent: 4800`. The budget file is momentarily unreadable (EACCES after a permissions change, EMFILE under load, or a truncated file from defect #5). `load()` swallows the error, returns `{spent: 0, limit: 50}`. Either the brand is now capped at 50 (service outage for a paying customer) or, once `setLimit` restores 5000, the 4800 already spent has been forgotten and the brand spends its entire monthly budget a second time.

**Fix:** only treat `ENOENT` as first-run; rethrow everything else.
```ts
} catch (e: any) {
  if (e?.code !== "ENOENT") throw e;
  this.state = { monthKey: this.currentMonthKey(), spent: 0, limit: 50 };
}
```

---

## 5. `budget.ts:84-87` — BLOCKER — `persist()` is unawaited and non-atomic, so concurrent writes interleave and recorded spend is lost on exit

`void writeFile(...).catch(() => {})` starts an overwrite (`w` mode truncates) without awaiting it, without a temp-file-plus-rename, and discards the error. Two overlapping `persist()` calls are two concurrent truncating writes to the same path.

**Failure scenario A (corruption):** `addSpend` fires a write of a 60-byte payload; before it completes a second `addSpend` fires a write of a 58-byte payload. The file is left with 58 bytes of new content plus 2 trailing bytes of the old — invalid JSON. The next `load()` hits defect #4 and resets the brand to `spent: 0, limit: 50`.

**Failure scenario B (loss):** the process receives SIGTERM immediately after `addSpend` returns. The write never reaches disk and the error is swallowed. On restart the spend is gone and the brand can exceed its limit by the lost amount.

**Fix:** make `persist` awaited and atomic, and let errors surface.
```ts
private async persist(): Promise<void> {
  const tmp = `${this.file}.tmp`;
  await writeFile(tmp, JSON.stringify(this.state));
  await rename(tmp, this.file);
}
```
and `await this.persist()` at each call site.

---

## 6. `sessionstore.go:88-92` — BLOCKER — `wg.Add(1)` is called *inside* the spawned goroutine, so `Close()` can return before journal writes finish

`sync.WaitGroup` requires `Add` to happen-before `Wait`. Here `Add` runs on the new goroutine, which may not be scheduled until after `Close()` has already called `Wait()`.

**Failure scenario:** `Purge()` evicts 200 sessions and spawns 200 goroutines; the process then begins shutdown and calls `Close()`. The counter is still 0 because none of the goroutines have run their first statement, so `Wait()` returns instantly and the process exits with the journal writes never performed. (The same race also produces `panic: sync: WaitGroup is reused before previous Wait has returned` when an `Add` lands concurrently with a `Wait` that is unblocking.)

**Fix:** move `Add` to the caller, before `go`.
```go
s.wg.Add(1)
sess := sess
go func() { defer s.wg.Done(); s.journal("purge", sess) }()
```

*Related, same lines:* the closure captures the range variable `sess` by reference. Under Go 1.21 and earlier (per-loop-scope range variables) all spawned goroutines can observe the same, final `sess`, journaling one session many times and others not at all. The `sess := sess` shadow above fixes this too; on Go 1.22+ the capture is already per-iteration and only the `wg.Add` placement matters.

---

## 7. `sessionstore.go:61` and `135-142` — BLOCKER — session fields are mutated and marshalled outside the mutex, a genuine data race

`Touch` writes `sess.LastSeen` while holding no lock at all (it released `RLock` on line 57). `journal` reads and marshals the whole session — including the `Turns` slice header — with no lock, and `AppendTurn` deliberately unlocks on line 73 *before* calling it.

**Failure scenario:** goroutine A runs `AppendTurn(id, "hi")`, unlocks, and enters `json.Marshal(sess)`. Goroutine B simultaneously runs `AppendTurn(id, "there")`; its `append` reallocates the backing array and rewrites the slice header (pointer, len, cap) non-atomically. A's `Marshal` reads a torn header — old pointer with new length — and serialises garbage or panics with an out-of-range slice read. Meanwhile `Touch` racing with `Purge`'s `now.Sub(sess.LastSeen)` read (line 85) is an unsynchronised read/write of a 24-byte `time.Time`, which can yield a nonsense idle duration and purge a session that is actively in use.

**Fix:** take the write lock in `Touch`, and marshal inside the critical section — snapshot the bytes under the lock and do only the file I/O outside it:
```go
// AppendTurn, still holding s.mu.Lock():
b, _ := json.Marshal(sess)
s.mu.Unlock()
s.writeJournalBytes(sess.ID, b)
```

---

## 8. `budget.ts:22-24` vs `39-40` — MAJOR — the two month keys use different formats *and* different timezones, so rollover is wrong

`currentMonthKey()` uses `getMonth()`, which is **0-based**, producing `"2026-06"` during July; `rollIfNeeded()` uses `toISOString().slice(0,7)`, producing `"2026-07"`. The first is local time, the second is UTC.

**Failure scenario A (off-by-one):** a brand's first-ever call in July writes `monthKey: "2026-06"`; the very next `rollIfNeeded` sees a mismatch and "rolls" immediately. In December `getMonth()` yields 11 → `"2026-11"`, which collides with the genuine November key, so a brand whose state was written in November is never rolled into December and keeps November's spend. Note also `String(6).padStart(2,"0")` is `"06"`, so the bug is invisible in the string shape — only the value is wrong.

**Failure scenario B (timezone):** for a tenant in UTC-7, the budget rolls to zero at 17:00 local on the last day of the month, granting a fresh full limit seven hours early.

**Fix:** use one helper for both, and pick one clock. E.g. make `rollIfNeeded` call `this.currentMonthKey()` and fix that method to `String(now.getMonth() + 1).padStart(2, "0")`.

---

## 9. `budget.ts:91-97` — MAJOR — `totalSpend` sums *remaining* budget, not spend

The doc comment and the name say "Sum spend across many brands for the org dashboard", but the loop accumulates `await b.remaining()`, which is `limit - spent`.

**Failure scenario:** three brands with limits 100 each and spend 10/20/30 (true total spend 60). The dashboard displays 240. As brands spend *more*, the reported "total spend" goes *down*; a fully-exhausted org reports 0 spend. Any alerting keyed off this number fires exactly backwards.

**Fix:** expose the spent figure and sum that.
```ts
async spentSoFar(): Promise<number> {
  const state = await this.load();
  this.rollIfNeeded(state);
  return state.spent;
}
// totalSpend: total += await b.spentSoFar();
```

---

## 10. `budget.ts:63-67` — MAJOR — `refund` skips `rollIfNeeded` and never clamps at zero, so spend can go negative and inflate the limit

Every other method rolls first; `refund` does not, and nothing prevents `state.spent` from dropping below 0.

**Failure scenario:** at 23:58 on 31 July a call costing 40 is recorded (spent = 40, limit 50). At 00:01 on 1 August a dashboard hit calls `remaining()`, which rolls the month and sets `spent = 0`. The July call's failure handler then calls `refund(40)` → `spent = -40`. August's effective budget is now 90 against a limit of 50 — a direct violation of the never-exceed invariant. Symmetrically, if no roll has happened yet, the refund lands on July's counter and is silently erased by the next roll, so a legitimate refund is lost.

**Fix:** roll first and clamp, and ideally key refunds to the month they were charged in:
```ts
this.rollIfNeeded(state);
state.spent = Math.max(0, state.spent - amount);
```

---

## 11. `sessionstore.go:99-107` — MAJOR — `Snapshot` returns live pointers, not the "stable copy" the package contract promises

The slice is fresh but every element aliases the live `*Session` still in the map. The `RLock` is released the instant `Snapshot` returns.

**Failure scenario:** the UI layer calls `Snapshot()` and iterates the result to render a list, reading `sess.Turns` and `sess.LastSeen`. Concurrently `AppendTurn` appends to the same `Turns` slice and `Touch` overwrites `LastSeen`. This is an unsynchronised read/write — the renderer can panic on a torn slice header, or emit a row showing a turn count that never existed. It also lets any caller mutate store state without going through the store, bypassing journaling entirely.

**Fix:** deep-copy inside the lock.
```go
cp := *sess
cp.Turns = append([]string(nil), sess.Turns...)
out = append(out, &cp)
```

---

## 12. `sessionstore.go:43-44` — MAJOR — reseeding the global RNG on every call makes session IDs collide

`rand.Seed(time.Now().UnixNano())` is executed per call. Any two calls that land in the same clock tick get the same seed and therefore the same first `rand.Uint32()` — the same session ID. `UnixNano` does not imply nanosecond *resolution*; the practical granularity of the monotonic clock read is often 100ns–1ms depending on platform.

**Failure scenario:** two users start sessions within the same clock tick. Both get id `s-1a2b3c4d`. The second `s.sessions[id] = sess` overwrites the first: user A's session object is orphaned, and A's subsequent `AppendTurn(id, ...)` writes into B's session — one user's conversation turns leak into another user's transcript, and the shared journal file `s-1a2b3c4d.json` records the merged state. Note also that the ID space is only 32 bits, so birthday collisions occur around ~77k sessions even with a correctly seeded RNG.

**Fix:** delete the `rand.Seed` line (the global source is auto-seeded in modern Go) and widen the ID, e.g. read 16 bytes from `crypto/rand` and hex-encode them.

---

## 13. `budget.ts:15, 27-37` — MAJOR — per-instance state caching means two `BrandBudget` objects for the same brand silently lose each other's spend

`this.state` is cached forever after the first `load()` and is never reconciled with the file. Nothing enforces one instance per brand.

**Failure scenario:** the API server constructs `new BrandBudget("acme", dir)` per request (or one per worker process). Instance 1 loads `spent: 10`, records 5, persists 15. Instance 2 loaded `spent: 10` earlier, records 5, persists 15 — last write wins. Twenty dollars of real spend is recorded as 15. Across N workers the limit is effectively N times larger than configured.

**Fix:** at minimum, cache per brand rather than per object (a module-level `Map<brandId, BudgetState>` plus a promise-chain mutex). Multi-process deployments need the file read-modify-written under an exclusive lock, or the counter moved to a shared store.

---

## 14. `budget.ts:76-82` — MAJOR — `setLimit` validates only for `NaN`, so negative and infinite limits are accepted

`parsed !== parsed` is a correct NaN test but the only one. `parseFloat` happily returns `-100`, `Infinity`, or a truncated number from a partly-numeric string.

**Failure scenario:** an admin fat-fingers `-100` (or the form posts `1e999`, which `parseFloat` returns as `Infinity`). With `-100`, every `canSpend` fails and the brand is hard-down until someone notices. With `Infinity`, `state.spent + amount < Infinity` is always true and the monthly cap is silently disabled — the never-exceed invariant is off entirely, and it round-trips through `JSON.stringify` as `null`, which then makes every comparison against `state.limit` false.

**Fix:**
```ts
if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid limit: ${input}`);
```

---

## 15. `sessionstore.go:74, 135-142` — MAJOR — journal writes for one session race each other, so an older state can be the one that survives

`journal` is called with no lock held and no per-session serialisation. Two calls for the same session write the *same* temp path `<id>.json.tmp` and then rename it.

**Failure scenario:** `AppendTurn(id, "one")` and `AppendTurn(id, "two")` run concurrently. Both marshal, both `os.WriteFile` to `<id>.json.tmp` — the two writes interleave into a single file — and both rename. Whichever rename lands second wins, which is not necessarily the newer state, and the file may contain bytes from both marshals. The `os.Rename` error is also discarded (line 142), so a failed rename leaves the journal permanently stale with no signal, and the `WriteFile` failure path (line 140) returns silently, so a session can simply never be journaled while callers believe it was.

**Fix:** use a unique temp name (`os.CreateTemp(s.dir, sess.ID+".*.tmp")`), serialise journal writes per session ID, and propagate the errors from `WriteFile`/`Rename` to the caller rather than dropping them.

---

## 16. `sessionstore.go:115-126` — MAJOR — `Replay` leaks a file descriptor per journal file and aborts the whole boot on one bad file

`defer f.Close()` inside a loop defers to *function* exit, so every handle stays open until `Replay` returns. Separately, an `os.Open` error returns immediately, abandoning all remaining sessions.

**Failure scenario:** a store with 20,000 journaled sessions. `Replay` holds 20,000 descriptors simultaneously; on a default macOS/Linux soft limit of 1024–10240 the `os.Open` on line 116 fails with EMFILE, `Replay` returns that error, and the service refuses to boot having loaded only a fraction of its sessions. One file with the wrong permissions produces the same total boot failure.

**Fix:** close inside the loop body (extract a small `loadOne(path)` helper so `defer` scopes correctly), and log-and-continue on per-file errors instead of returning.

---

## 17. `sessionstore.go:110-126` — MINOR — `Replay` writes the map without holding the lock and ingests leftover `.tmp` files

Nothing in the signature or comment restricts `Replay` to a quiescent boot, and it reads every directory entry indiscriminately.

**Failure scenario:** if `Replay` is ever called on a live store (a manual "reload from disk" admin action, or a second call after a failed first), its unsynchronised `s.sessions[sess.ID] = &sess` races with live traffic and can crash the process with `concurrent map writes`. Independently, a `<id>.json.tmp` left behind by defect #15 that happens to contain complete JSON is decoded and loaded as if it were committed state, and directory entries that are subdirectories are opened and silently skipped only by luck of the decode failing.

**Fix:** take `s.mu.Lock()` for the duration, and skip entries that are directories or whose name does not end in `.json`.

---

## 18. `budget.ts:51` — MINOR — `canSpend` uses `<` where `<=` is meant, rejecting a call that lands exactly on the limit

**Failure scenario:** limit 50, spent 45, a call costs exactly 5. `45 + 5 < 50` is false, so the call is refused even though it would land the brand precisely at its budget, and `remaining()` keeps reporting `5` available forever. The last few cents of every brand's budget are permanently unspendable and the dashboard disagrees with the enforcement.

**Fix:** `return state.spent + amount <= state.limit;`

---

## 19. `budget.ts:69-73` — MINOR — `remaining()` mutates state as a side effect but never persists the roll

`rollIfNeeded` sets `monthKey` and zeroes `spent` in memory; `remaining()` does not call `persist()`.

**Failure scenario:** the first request of a new month is a dashboard read. `remaining()` rolls in memory (spent 0) and returns the full limit, but the file still holds last month's `spent: 48`. The process restarts before any `addSpend` occurs; the next `load()` reads `spent: 48` and the brand is reported as nearly exhausted again, flapping between two answers depending on restart timing.

**Fix:** have `rollIfNeeded` return whether it rolled and `persist()` when it did, so the roll is durable regardless of which method triggered it.

---

# Style / non-defect observations (not counted)

- `budget.ts` accumulates dollars as IEEE-754 doubles; `0.1 + 0.2` drift will eventually make `spent` disagree with the sum of the recorded charges by fractions of a cent. Integer cents would be more robust, though no concrete failure follows from the code as written.
- `canSpend`/`addSpend`/`refund` accept negative or `NaN` `amount` values without validation; whether that is reachable depends on callers not shown in the excerpt.
- `remaining()`'s `toFixed(2)` rounds a value that the enforcement path compares unrounded, so display and enforcement can differ by up to half a cent.
- `sessionstore.go`'s `journal` never `fsync`s the temp file or the directory before/after `os.Rename`, so the "crash-safe" claim in the header holds only against process crashes, not power loss.
- `Store.Close()` waits but does not mark the store closed, so work started after `Close()` is neither waited for nor rejected.
- The header calls the journal "append-only", but it is in fact one last-write-wins file per session; the naming will mislead future maintainers even once the purge bug (#2) is fixed.
- `journal`'s `op` parameter is unused at every call site; either honour it or drop it.
