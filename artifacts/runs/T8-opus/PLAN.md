# Migration plan — `legacy-uploader.js` → TypeScript / async / testable

Scope: same module, same observable behavior, shipped in increments that each stand alone and can be
reverted at a release boundary. Line references are to the current `legacy-uploader.js`.

---

## 1. Findings — what constrains the migration

### 1.1 Module-level mutable state (shared across every instance and every consumer)

| Line | Thing | Why it constrains us |
|---|---|---|
| 11, 156 | `activeUploads` object is **exported by reference** | Consumers hold the same object and can enumerate/mutate it. It can never be reassigned, wrapped in a getter, or swapped for a `Map` without breaking them. Entry shape `{file, started}` (line 32) is a public contract — `started` is unused internally, so its only consumer is external (almost certainly a stall/progress UI). |
| 12, 31 | `uploadCounter` is module-global | IDs are `u<N>`, monotonic **process-wide**, not per-instance. Two `Uploader` instances interleave IDs. Anything that parses/sorts IDs depends on this. Not reset by `_resetForTests`. |
| 13, 57 | `globalRetryDelay` is module-global and **only ever grows** | One 429 anywhere permanently slows every future retry in the process. It doubles *before* the first sleep (line 57 then 58), so the first backoff is 1000 ms and the literal `500` is never used as a delay. N concurrent 429s double it N times (3 concurrent → 4000 ms). Never reset — not on success, not by `_resetForTests`. |
| 10 | `UPLOAD_HOST` is read **at module load** | `process.env.ASSET_HOST` set after the first `require` has no effect. Tests must set env before import; any refactor to a lazily-read config object is a behavior change. |
| 149, 152–155 | `getUploader(opts)` singleton **silently ignores later opts** | With ~40 call sites, whichever one runs first wins `concurrency`, `tmpDir` and `tokenProvider` for the whole process. Some call sites are certainly passing options that do nothing today. "Fixing" this changes production behavior. |
| 157 | `_resetForTests` only nulls `defaultUploader` | It does **not** reset `uploadCounter`, `globalRetryDelay`, or clear `activeUploads`. Test-order-dependent state leaks between cases — this must be solved before any characterization suite can be trusted. |

### 1.2 Crash / stall hazards (the ones that make this migration risky)

- **Unguarded sync I/O inside the job (lines 43, 52).** Only `statSync` is wrapped in `try/catch`
  (37–39). `fs.copyFileSync` and `fs.readFileSync` are not. A file deleted between stat and read,
  `EMFILE`, or `ENOSPC` on the tmp copy throws synchronously out of the `_readToken` callback →
  `done()` is never called → `this.running` is never decremented → **a concurrency slot is leaked
  permanently**; three such failures wedge the queue forever. Also `activeUploads[id]` leaks. In the
  Electron main process this surfaces as an uncaught exception, not a rejected promise.
- **Same stall from header construction (lines 104–107).** `JSON.stringify(meta)` throws on circular
  meta; non-ASCII or newline characters in the serialized meta make `https.request` throw
  `ERR_INVALID_CHAR`. Both throw synchronously on the same path → same wedged slot.
- **Fd leak (lines 134–136).** `openSync` / `readSync` / `closeSync` with no `try/finally`. A throwing
  `readSync` leaks the fd *and* wedges the slot as above.
- **Double callback (lines 120 + 113–117).** `req.on('error', cb)` stays attached after the response
  completes; a post-response socket error calls `cb` a second time. Downstream that means `done()`
  runs twice → `this.running` goes **negative** → effective concurrency silently inflates for the
  rest of the process. This matters enormously for the migration: naively wrapping `_send` in a
  Promise makes it settle-once and *silently fixes* this, which is a behavior change we have not
  agreed to. Any promisification must preserve multi-invocation until we deliberately ticket it.
- **No request timeout, no agent config (line 101).** A hung socket holds a concurrency slot forever.
  There is no `req.setTimeout`, no `keepAlive`, no explicit TLS options — the module inherits ambient
  `NODE_EXTRA_CA_CERTS` etc. Don't touch TLS during migration.
- **Blocking the main process.** `statSync`, `copyFileSync` (up to whatever the largest artifact is),
  `readFileSync` (up to 64 MB), and per-chunk `readSync` all block the Electron main process, stalling
  IPC and the UI. Converting these to async is the *point* of the migration but it reorders
  interleaving with everything else on the main loop — it is the single highest-risk change here.

### 1.3 Control-flow quirks that are load-bearing

- **Zalgo (lines 33–39, 69–70).** `_drain()` is called synchronously from `upload()`. If a slot is
  free and a caller supplied a **synchronous** `tokenProvider`, the token-error path (35) and the
  stat-error path (38) invoke `cb(err)` *before `upload()` has returned the id*. Any consumer using
  the returned id inside its own callback would see `undefined` today. The default `_readToken`
  (`fs.readFile`, line 93) is async, so this only fires for injected providers — but injected
  providers are exactly what the singleton's first caller supplies. Async/await defers everything
  uniformly and removes this; that is a real, if perverse, behavior change.
- **429 retry is buffered-path only (lines 56–62).** Chunked uploads surface 429 to the caller as an
  error; small uploads retry **forever**, uncapped, via `self.upload(...)` re-enqueue. The retry
  creates a **new id** the caller never receives, so `cancel()` on the original id can no longer
  affect it. The retry re-runs `_readToken`, so a refreshed token is picked up.
- **`done` events are asymmetric (lines 35, 38, 47, 54).** `emit('done', id, err)` fires on the send
  paths but **not** on token-failure or stat-failure. And on a 429 it fires with the error *and then
  again later* under the retry's new id — listeners double-count. There is **no `'error'` event**;
  adding one would crash the main process for any instance without a listener.
- **`cancel()` is bookkeeping only (74–77).** It does not abort in-flight requests and does not remove
  the job from `this.queue` — a cancelled-but-not-yet-started upload still uploads and still fires
  its callback. `cb` fires regardless of cancellation.
- **Result shape differs by size (lines 44/131 vs 52/117).** Buffered uploads resolve with the parsed
  server JSON (or `{raw: out}` when parsing fails, line 116). Chunked uploads resolve with a locally
  synthesized `{uploadId, size}` — the server response is discarded and never validated, so a failed
  server-side assembly still reports success. Call sites certainly branch on this.
- **Threshold is `> 64MB`, exclusive (line 41).** Exactly 67108864 bytes takes the buffered path.
- **Stale size in the chunk loop (lines 41 → 43 → 131–138).** `size` comes from the pre-copy `stat`.
  `readSync` past EOF returns short but `buf` was `Buffer.alloc(len)` and is sent at **full length**,
  so a shrinking file is silently zero-padded on the wire.
- **Per-chunk MD5 (line 100).** `x-digest` is the digest of the chunk, not the file, on the chunked
  path. Server contract; do not "improve" it. (MD5 also throws under FIPS-mode Node.)
- **Response decoding (lines 110–112).** No encoding set on `res`, so `out += d` stringifies each
  Buffer independently — a multi-byte UTF-8 sequence split across TCP chunks becomes replacement
  characters, corrupting error text and occasionally breaking `JSON.parse` into the `{raw}` fallback.
- **`setImmediate` in `_drain` (line 86).** Draining is macrotask-scheduled. Rewriting the pump with
  promises moves it to the microtask queue and changes interleaving with other main-process work.
- **Unbounded queue (line 69).** No backpressure; 40 call sites can enqueue arbitrarily.
- **Orphaned tmp files (lines 42–45).** `.part` files leak if the process dies mid-upload; nothing
  cleans `tmpDir` at startup.

### 1.4 Object-model contracts that break silently under `class`

- **`Uploader.prototype = Object.create(EventEmitter.prototype)` (line 25) never restores
  `constructor`.** Today `new Uploader().constructor === EventEmitter` and `.constructor.name` is
  `"EventEmitter"`. `class Uploader extends EventEmitter` fixes this — a change any logging or
  type-dispatch code could notice.
- **Prototype methods are enumerable.** `for (const k in uploader)` yields `upload`, `cancel`,
  `_drain`, `_readToken`, `_send`, `_sendChunked`. Class methods are non-enumerable. Object spread,
  ad-hoc serialization, and DI containers can all see this.
- **`Uploader(opts)` works without `new`** (sloppy mode, no strict directive in the file). A class
  throws. With 40 call sites, assume at least one does this until proven otherwise.
- **`_`-prefixed methods are de facto public seams.** Existing tests almost certainly stub
  `Uploader.prototype._send`. TS `private`/`#private` or class-field arrow methods break that.
- **`this.tokenProvider(cb)` (line 92) is a method call** — providers receive `this === uploader`.
  Extracting it to a free function or destructuring it changes `this` for any provider that uses it.
- **Path resolution is split (lines 22 vs 93).** `tmpDir` resolves `process.cwd()` **at construction**;
  `token.txt` resolves `process.cwd()` **per upload**. In a packaged Electron app `process.cwd()` is
  frequently `/`, so the app is either chdir-ing at startup or always injecting both — either way this
  is an undocumented environmental contract that must be pinned before anything moves.
- **Constructor does sync, non-recursive `mkdirSync` (line 23)** with a TOCTOU gap after `existsSync`.
  It throws if the parent directory is missing — construction can fail, and does so synchronously.

---

## 2. Migration plan

Ordering principle: **make it observable, then make it swappable, then make it typed, then make it
async** — types before behavior, seams before implementations. Every step below ships alone, is
reverted by reverting one commit, and is judged against the Step 0 suite unchanged.

### Step 0 — Characterization harness (blocking prerequisite)

Build a test harness against the *current* file with no source edits beyond what Step 0.1 requires.

- Local HTTPS fixture server (self-signed, host overridden via `ASSET_HOST` set before import) plus
  scripted socket faults; fake timers; per-test temp cwd; module registry reset per test.
- **0.1 — the one allowed source edit:** extend `_resetForTests` to also reset `uploadCounter`,
  `globalRetryDelay`, and clear `activeUploads` **in place** (`delete` each key; never reassign).
  Ship this alone. Production never calls it, so blast radius is tests only.
- Cases that must be pinned: id format and cross-instance monotonicity; `activeUploads` entry shape,
  add/remove timing, and object identity; the 64 MB boundary at exactly `64*1024*1024` and `+1`;
  buffered vs chunked result shapes; chunk sizes/offsets/`x-upload-id`/per-chunk digest; the
  429 doubling ladder (1000, 2000, 4000…) and its process-wide persistence and non-reset; 429 on the
  chunked path erroring instead of retrying; retry issuing a fresh id; `done` emitted on send paths
  and *not* on token/stat failure; `done` fired twice across a 429 retry; `cancel()` not aborting and
  not dequeuing; sync-tokenProvider callback firing before `upload()` returns; `getUploader` ignoring
  later opts; `UPLOAD_HOST` bound at load; the `{raw}` JSON fallback; the wedged-slot behavior on a
  throwing `readFileSync` (assert the current stall — it is the contract until we ticket it).
- **Risk:** low (tests only). **Proof:** suite green on unmodified source. **Revert:** delete tests.
- **Size: L.** This is the expensive step and it is non-negotiable — every later step's safety comes
  from here.

### Step 1 — Freeze the public surface (types + surface snapshot, zero runtime change)

- Hand-write `legacy-uploader.d.ts` describing exports, the callback overloads
  (`upload(f, cb)` / `upload(f, meta, cb)` / `upload(f, meta)`), `activeUploads`, and the two result
  shapes as a union. Add `// @ts-check` + JSDoc to the source so `tsc --noEmit` checks it.
- Add a surface-snapshot test: `Object.keys(module.exports)`, `Object.keys(Uploader.prototype)` **in
  order and asserting enumerability**, `instance.constructor === EventEmitter`, `Uploader.call({})`
  not throwing, id regex.
- **Risk:** low. Call sites gain types and may reveal existing type errors — fix those in *their* own
  commits, not here. **Proof:** no emitted-JS change; surface snapshot + Step 0 suite.
- **Size: M.** Critical path.

### Step 2 — Single import door

- Add `src/uploader/index.js` that re-exports the legacy module verbatim. Codemod all ~40 call sites
  to import it. No logic anywhere.
- **Risk:** low, but it is a 40-file diff — land it in one commit on a quiet day, verify the diff is
  purely import-path churn, and smoke the app.
- **Why:** every later swap becomes a one-line change behind one door, and every later revert becomes
  a one-line revert. Without this, Steps 5–6 are not independently revertible.
- **Proof:** import-graph assertion (nothing outside `src/uploader/` requires the legacy path) + full
  app smoke. **Size: S** (mechanical) / M with review of 40 sites.

### Step 3 — Dependency seams (still JS, still callbacks)

- Thread a `deps` object — `{fs, https, crypto, setTimeout, setImmediate, cwd, env}` — defaulting to
  the real modules, stored on the instance. `UPLOAD_HOST` stays module-level and load-time-bound;
  only its *read* moves behind `deps.env`, evaluated at the same moment as today.
- Keep every method on the prototype, enumerable, `_`-prefixed, same arity, same `this`.
- **Risk:** medium — it is easy to accidentally change *when* something is read. Review specifically
  for construction-time vs call-time resolution of `cwd` (lines 22 vs 93).
- **Proof:** Step 0 suite runs **unchanged, still using global mocks**; a second copy of the suite is
  then rewritten to inject `deps` and must produce identical assertions. **Size: M.** Critical path.

### Step 4 — Mechanical TypeScript conversion (types only, no semantics)

- `allowJs` + `checkJs` build already in place from Step 1; rename `.js` → `.ts`, keep `var`, keep the
  constructor function and `Object.create` prototype wiring, keep `module.exports = {...}` via
  `export =`. Target the same CommonJS + ES version the app already ships.
- **Explicitly do not convert to `class`** — it changes `constructor` identity, method enumerability,
  and `new`-less construction (§1.4). Type the prototype with an interface and `@ts-expect-error`
  where the prototype dance defeats the checker. Accept the ugliness; it is temporary and honest.
- **Risk:** medium. Downleveling and `esModuleInterop` can alter the emitted require/export shape.
- **Proof:** diff the emitted JS against the original file line-by-line and justify every difference in
  the PR body; surface snapshot; Step 0 suite against the **compiled output**, not the source.
- **Size: M.** Critical path.

### Step 5 — Async internals, one method per release, each behind its own flag

Order is bottom-up so each converted method has only converted or untouched dependencies:

**5a `_readToken`** → **5b `_send`** → **5c `_sendChunked`** → **5d `_drain` + `upload`**

Rules that apply to all four:

- The method keeps its callback signature. Internally it is `async`; the outer shell is a thin adapter.
- The adapter is **deliberately not settle-once** for `_send` (§1.2) — preserve the double-callback
  path until it is ticketed and fixed separately.
- Where a path can invoke `cb` synchronously today (token/stat errors under a sync provider), the
  adapter must **keep it synchronous**. Do not let `await` insert a microtask tick there. This is the
  single subtlest requirement in the whole migration; assert it explicitly.
- Sync I/O becoming async in 5b/5c/5d is where main-process interleaving actually changes. Ship 5c
  (the chunked/`copyFileSync` path, lowest traffic) before 5d (the pump, highest traffic).
- Each substep is behind an independent runtime flag defaulting **off**, flipped on in the *following*
  release once telemetry is clean. Abort = flip the flag, no revert needed.
- **Risk:** 5a low, 5b medium, 5c medium, 5d **high** (it is the concurrency pump; a bug here wedges
  or unbounds all uploads).
- **Proof per substep:** Step 0 suite green with the flag both off and on; plus a
  **dual-run differential test** for 5d — old and new pump driven by the same scripted event
  sequence, asserting identical ordering of `done` emissions, callback invocations, `running` values
  at each tick, and `activeUploads` key sets.
- **Telemetry to add before 5b:** slot-occupancy gauge and `running` value (to catch the negative-
  `running` case), queue depth, uncaught-exception counter tagged to this module.
- **Size:** 5a S, 5b M, 5c M, 5d L. 5d is the critical path's tail.

### Step 6 — Additive promise API

- Export `uploadAsync(filePath, meta): Promise<Result>` next to the callback API. It is a wrapper; it
  settles once and rejects normally. New code uses it. Existing call sites are **not** touched.
- **Risk:** low (purely additive). **Proof:** new tests only. **Size: S.**

### Step 7 — Call-site migration (out of scope for this project)

Call sites move to `uploadAsync` opportunistically, whenever their owning team is in the file anyway.
Removing the callback shell requires the count to reach zero; that is a future project, not this one.

### Abort semantics

After any step, stopping is a stable end state. Steps 0–4 leave a typed, seam-injected, fully
characterized module with unchanged behavior — a good place to stop indefinitely. Within Step 5,
abort means leaving the flags off; the dead new code is harmless and can be deleted lazily.

---

## 3. Non-goals and traps deliberately left alone

Not fixed during migration, because each is a behavior change and behavior must not change:

1. `globalRetryDelay` never resetting and being process-global.
2. Uncapped, infinite 429 retries, and the fresh-id-per-retry that orphans `cancel()`.
3. 429 retry existing only on the buffered path.
4. Double-callback from `req.on('error')` and the resulting negative `running`.
5. Wedged concurrency slots from unguarded `copyFileSync` / `readFileSync` / header construction.
6. The `readSync` fd leak.
7. Missing request timeout / socket-hang handling.
8. `getUploader` silently ignoring later opts.
9. Divergent result shapes between buffered and chunked, and chunked never confirming server assembly.
10. Zero-padding on the wire when a file shrinks after `stat`.
11. Missing `done` emission on token/stat failure; double `done` across a retry.
12. `cancel()` neither aborting nor dequeuing.
13. UTF-8 corruption from unencoded response concatenation.
14. Per-chunk MD5, and MD5 itself.
15. `activeUploads` being an exported mutable global.
16. Unbounded queue / no backpressure.
17. Orphaned `.part` files.
18. `constructor === EventEmitter`, enumerable prototype methods, `new`-less construction.

Also explicitly **not** doing: converting to `class`; renaming `_`-prefixed methods; introducing an
`'error'` event; restructuring the module into multiple files/layers; changing the wire protocol,
headers, or TLS configuration; touching the ~40 call sites beyond the Step 2 import path.

### Ticket-worthy, after the migration lands

- **P0** — wedged concurrency slot (§1.2 items 1–3): wrap the job body so `done()` always runs.
  Needs a decision on whether the upload then reports failure or retries.
- **P0** — request timeout + explicit socket-error handling; settle-once on `_send`.
- **P1** — cap 429 retries, decay `globalRetryDelay`, move it per-instance; keep the caller's id
  stable across retries so `cancel()` keeps working.
- **P1** — make `cancel()` real: dequeue pending jobs, `req.destroy()` in-flight ones.
- **P1** — 429 handling on the chunked path; confirm server assembly before reporting success.
- **P2** — unify the two result shapes behind a discriminated union (needs a call-site sweep).
- **P2** — `getUploader` should throw (or warn loudly) when given opts after first construction.
- **P2** — fd leak; `res.setEncoding('utf8')`; re-stat before chunking; startup `tmpDir` sweep.
- **P3** — queue bounds; replace MD5 if the server will accept a stronger digest.

---

## 4. Sizing and critical path

| Step | Size | Risk | Independently shippable |
|---|---|---|---|
| 0 — characterization harness (+ `_resetForTests` fix) | **L** | low | yes |
| 1 — surface freeze, `.d.ts`, snapshot | M | low | yes |
| 2 — single import door (40 sites) | S–M | low (wide diff) | yes |
| 3 — dependency seams | M | med | yes |
| 4 — mechanical TS conversion | M | med | yes |
| 5a — `_readToken` async | S | low | yes (flagged) |
| 5b — `_send` async | M | med | yes (flagged) |
| 5c — `_sendChunked` async | M | med | yes (flagged) |
| 5d — `_drain` / `upload` async | **L** | **high** | yes (flagged) |
| 6 — additive promise API | S | low | yes |

**Critical path:** 0 → 1 → 3 → 4 → 5a → 5b → 5c → 5d. Step 2 is off the critical path for
correctness but must land before 5a to make the flag flips revertible in one place. Step 6 depends
only on 4, so it can be pulled forward if a consuming team needs the promise API early.

The two steps that dominate the schedule are **0** and **5d**, and they dominate for the same reason:
5d is only safe to the extent 0 is thorough. Steps 1–4 are cheap, low-risk, and deliver most of the
"typed and testable" value on their own — if the project is cut short, cut it after 4.
