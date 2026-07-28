# Review

## Defects

### 1. `sessionstore.go:47` — blocker

**Claim:** `NewSession` mutates the `sessions` map while holding only an `RLock`, so concurrent use can race or terminate the process with a concurrent-map-write failure.

**Failure scenario:** Two goroutines call `NewSession` at the same time; both acquire the shared read lock and assign into the same map, producing a data race and potentially `fatal error: concurrent map writes`.

**Minimal suggested fix:** Hold `s.mu.Lock()`/`Unlock()` around the map assignment (and any associated state capture), not `RLock`/`RUnlock`.

### 2. `budget.ts:48` — blocker

**Claim:** The limit check and charge are separate, non-atomic operations, so concurrent calls can both pass `canSpend` and then take the brand over its limit.

**Failure scenario:** With `spent = 40` and `limit = 50`, two calls costing `$8` concurrently observe `$48 < $50`, both proceed, and both call `addSpend`, leaving `spent = 56` despite the never-exceed requirement.

**Minimal suggested fix:** Replace the check-then-record API with one serialized `reserve(amount)` operation that validates and increments before the paid call; refund that reservation if the call is not billed.

### 3. `sessionstore.go:91` — major

**Claim:** Purging writes the deleted session back as an ordinary session record, and replay ignores the `op` argument entirely, so purged sessions are resurrected after restart.

**Failure scenario:** An expired session is removed from memory, `journal("purge", sess)` rewrites `<id>.json` with the full session, and the next `Replay` unconditionally inserts that session into the map.

**Minimal suggested fix:** Persist a replayable purge tombstone (including the operation), or atomically remove the persisted record, and make replay apply purge operations rather than treating every record as live state.

### 4. `budget.ts:84` — major

**Claim:** Persistence is fire-and-forget, unordered, and has all errors suppressed, so successful mutating methods do not guarantee restart-safe state and concurrent writes can leave an older snapshot on disk.

**Failure scenario:** Two `addSpend` calls schedule snapshots for `$10` and `$20`; the `$20` write completes first and the `$10` write completes last (or the process exits before either completes), so restart restores `$10` or the pre-call value while both calls reported success.

**Minimal suggested fix:** Serialize writes through an awaited promise/queue, write via a temporary file plus atomic rename, propagate failures, and make `Close` await the queue.

### 5. `sessionstore.go:74` — major

**Claim:** `AppendTurn` releases the store lock before journaling a mutable session pointer, allowing concurrent mutations and journal calls to race and persist stale or inconsistent state.

**Failure scenario:** One append captures `["a"]` and is delayed while a second append captures and persists `["a", "b"]`; the first call then overwrites the shared temporary/final path with `["a"]`, so turn `b` disappears after restart.

**Minimal suggested fix:** Take an immutable deep copy while holding the lock and serialize journal writes for each session (using unique temporary files or a single writer).

### 6. `sessionstore.go:61` — major

**Claim:** `Touch` writes `LastSeen` after releasing the lock, causing a data race with purge, snapshots, and journal serialization.

**Failure scenario:** `Touch` assigns `LastSeen` while `Purge` reads it under the store lock; the access is unsynchronized, so purge can race and remove a session that is being marked active.

**Minimal suggested fix:** Perform the lookup and `LastSeen` assignment while holding `s.mu.Lock()`.

### 7. `sessionstore.go:104` — major

**Claim:** `Snapshot` copies only pointers, not sessions or their `Turns` slices, so callers do not receive the promised stable copy and can mutate store-owned state without locking or journaling.

**Failure scenario:** A renderer obtains a snapshot while another goroutine appends a turn, or a caller changes `snapshot[0].Brand`; the snapshot changes/races in the first case and silently alters the store in the second.

**Minimal suggested fix:** Under the read lock, copy each `Session` value and clone each `Turns` slice before returning pointers to those copies.

### 8. `sessionstore.go:136` — major

**Claim:** All serialization and filesystem failures in `journal` are discarded, so mutation APIs can report success even though the mutation will be lost on restart.

**Failure scenario:** The disk is full during `AppendTurn`; `os.WriteFile` fails, `AppendTurn` still returns `nil`, and the newly added turn vanishes after a restart.

**Minimal suggested fix:** Return errors from `json.Marshal`, `WriteFile`, and `Rename`, propagate them through mutating APIs, and define rollback/retry behavior when persistence fails.

### 9. `budget.ts:32` — major

**Claim:** `load` treats every read or parse failure as a first run and resets spend to zero, converting corruption and transient I/O failures into extra budget.

**Failure scenario:** A brand has already spent its `$50` limit, but its JSON file is temporarily unreadable or malformed; `load` creates `{ spent: 0, limit: 50 }`, and another paid call is allowed.

**Minimal suggested fix:** Only initialize defaults on an explicit file-not-found error; reject malformed content and propagate all other read errors.

### 10. `budget.ts:94` — major

**Claim:** `totalSpend` adds each brand's remaining allowance rather than its spend, so the organization dashboard reports the wrong quantity.

**Failure scenario:** Two brands have limits of `$50` and have spent `$10` and `$20`; `totalSpend` returns `$70` (`40 + 30`) instead of `$30`.

**Minimal suggested fix:** Expose a rollover-aware `spent()` method and sum that value instead of `remaining()`.

### 11. `budget.ts:24` — major

**Claim:** Month keys are inconsistent: `currentMonthKey` uses a zero-based local month while rollover uses a one-based UTC month, causing incorrect and timezone-dependent rollovers.

**Failure scenario:** In local July, a new state is labeled `2026-06`; near a local month boundary, `rollIfNeeded` may also observe the next UTC month and reset current-month spend hours early.

**Minimal suggested fix:** Use one helper everywhere that derives a one-based month key in a single chosen timezone, for example `new Date().toISOString().slice(0, 7)`.

### 12. `budget.ts:63` — major

**Claim:** `refund` neither rolls the month nor verifies a prior reservation, so it can create negative spend and thereby permit costs beyond the configured limit.

**Failure scenario:** With `spent = 2`, a failed `$10` call invokes `refund(10)` and sets spend to `-8`; a subsequent `$57` call passes the `$50` check because `-8 + 57 = 49`.

**Minimal suggested fix:** Refund only an identified prior reservation in the applicable month, reject invalid/excess refunds, and never allow `spent` to become negative.

### 13. `sessionstore.go:89` — major

**Claim:** `Purge` increments the `WaitGroup` inside the new goroutine, so `Close` can call `Wait` while the count is still zero and return before that journal write starts.

**Failure scenario:** `Purge` launches a journaling goroutine and is immediately followed by `Close`; the scheduler runs `Close` first, `Wait` returns, and shutdown proceeds while the untracked write starts afterward.

**Minimal suggested fix:** Call `s.wg.Add(1)` synchronously before starting the goroutine, then keep only `Done` inside it; also prevent new work once closing begins.

### 14. `sessionstore.go:120` — major

**Claim:** `Replay` defers every file close until the whole loop returns, so a large store can exhaust file descriptors and fail partway through recovery.

**Failure scenario:** Replaying thousands of session files reaches the process's open-file limit because none are closed per iteration; a later `os.Open` fails and boot aborts with only part of the store loaded.

**Minimal suggested fix:** Decode each file in a small helper that defers its close, or close it explicitly before the next iteration.

### 15. `sessionstore.go:61` — major

**Claim:** `Touch` is a state mutation but is never journaled, so recent activity is lost across restart and can cause active sessions to be purged as expired.

**Failure scenario:** A session created at 10:00 is touched at 10:59 with a one-hour TTL, then restarts at 11:01; replay restores the 10:00 `LastSeen`, and purge deletes the session despite activity two minutes earlier.

**Minimal suggested fix:** Journal the updated immutable session state as part of the locked touch operation and report persistence failure.

### 16. `sessionstore.go:43` — major

**Claim:** Session IDs contain only 32 random bits and collisions overwrite existing map and journal entries without detection, causing session data loss or cross-session mixing.

**Failure scenario:** After enough sessions, `rand.Uint32()` repeats an existing ID; `NewSession` replaces that session in memory and rewrites its file, while holders of the old pointer still believe they own the same ID.

**Minimal suggested fix:** Use a collision-resistant identifier (such as a UUID or 128-bit cryptographic random value) and still reject/regenerate any ID already present.

### 17. `sessionstore.go:122` — major

**Claim:** `Replay` silently skips every decode failure and returns success, hiding journal corruption while dropping sessions from recovered state.

**Failure scenario:** One canonical session file is truncated; replay ignores its JSON error, returns `nil`, and the application starts with that session missing instead of surfacing failed recovery.

**Minimal suggested fix:** Ignore only explicitly recognized non-journal files; return a contextual error for an invalid journal record (or quarantine it while reporting degraded recovery).

### 18. `budget.ts:51` — minor

**Claim:** The strict `<` comparison rejects a call that would bring spend exactly to the limit even though the requirement forbids only exceeding it.

**Failure scenario:** With `$40` spent and a `$50` limit, a `$10` call is rejected because `50 < 50` is false, although the resulting spend would not exceed the limit.

**Minimal suggested fix:** Once checking and reservation are atomic, allow the operation when `spent + amount <= limit`.

### 19. `budget.ts:78` — minor

**Claim:** `setLimit` uses permissive `parseFloat` validation, accepting partial, negative, and infinite values as monthly limits.

**Failure scenario:** Form input `"50oops"` is silently accepted as `$50`, while `"Infinity"` removes the effective cap and `"-1"` creates an unusable budget.

**Minimal suggested fix:** Require the entire trimmed input to represent a finite, non-negative amount (preferably convert it to integer cents) before assigning it.

## Non-defect observations

- The monetary state uses binary floating-point dollars; integer cents would make financial arithmetic and validation easier to reason about, but no standalone limit breach follows from that representation without additional invalid or concurrent inputs already covered above.
