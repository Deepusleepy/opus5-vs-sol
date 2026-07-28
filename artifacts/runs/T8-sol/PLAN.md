# Legacy uploader migration plan

## Compatibility rule

The existing CommonJS entry point, exports, callback API, event ordering, queue semantics, side effects, and known failure modes are the contract. Migration work may add internal seams and an opt-in implementation, but may not require changes at the roughly 40 call sites. A release can stop with the legacy implementation still selected.

## Findings

### Construction, process state, and exports

| Lines | Current behavior / hidden contract | Why it constrains migration |
|---|---|---|
| 10 | `ASSET_HOST` is read once at module evaluation; an empty value falls back to `assets.internal`. | Reading configuration per instance/request would change tests, runtime reconfiguration, and module-cache behavior. |
| 11–13, 31 | Active uploads, IDs, and retry delay are module-global across all uploader instances. IDs are process-wide, monotonic `u1`, `u2`, … and start only when `upload()` is called. | Per-instance state, UUIDs, or resetting counters changes observable IDs and cross-instance coupling. |
| 15–24 | Constructor is callable with missing/falsy options. `concurrency || 3` means `0`, `NaN`, and `''` become 3, while negative/truthy non-numeric values are retained. | Normalizing or validating options could revive or reject configurations that currently stall or coerce oddly. |
| 21–23, 91–96 | Default temp directory is based on `cwd` at construction, but the fallback token path uses `cwd` at token-read time. | Capturing one working directory for both changes behavior if the process calls `chdir()`. |
| 22–24 | Temp-directory setup is synchronous, non-recursive, and may throw from the constructor; the exists/create sequence has a race. Existing paths are accepted without checking that they are directories. | Eager async setup, recursive creation, or error wrapping changes throw timing and accepted states. |
| 16, 25 | Instances inherit `EventEmitter` behavior, but the prototype's `constructor` is not restored. | A class conversion can change `instance.constructor` and reflection behavior. |
| 148–157 | `getUploader()` is a lazy process singleton. Only the first call's options count; later options are silently ignored. | A factory, eager singleton, or option merging would alter production configuration. |
| 156 | The exact mutable `activeUploads` object is exported. External code can observe and mutate it. | Replacing it with a `Map`, snapshot, getter, or candidate-owned object breaks identity and mutability. |
| 157 | `_resetForTests()` resets only the singleton. It does not clear active entries, ID sequence, retry delay, queued work, timers, or existing instances. | “Improving” reset semantics can invalidate existing tests and conceal state leaks. |

### Public upload, bookkeeping, events, and cancellation

| Lines | Current behavior / hidden contract | Why it constrains migration |
|---|---|---|
| 27–32, 71 | API is callback-based and returns the ID synchronously. `upload(path, cb)` sets metadata to `{}`; otherwise metadata is retained by reference, including `undefined`. Callback is optional. | A Promise return, argument cloning, or delayed ID allocation is incompatible. Later metadata mutation can affect a queued upload or retry. |
| 32, 69–70 | An `activeUploads[id] = {file, started}` entry is created before enqueue/drain, so queued jobs are considered active. `started` is wall-clock time at API invocation. | Moving registration to actual I/O changes monitoring and cancellation observations. |
| 34–39 | Token is obtained before the source is statted. Token/stat failures delete the active entry, call the optional callback, then free the queue slot; they do **not** emit `done`. | Reordering validation, emitting uniformly, or changing callback/slot order is observable. |
| 40–53 | Chunking is selected only when the stat size is strictly greater than 64 MiB. Small files are then read wholly and synchronously; source changes between stat and read are possible. No regular-file check is made. | Streaming all files, using `>=`, or validating file type changes the selected protocol and errors. |
| 43, 52 | Copy/read operations are synchronous in the Electron main process and may throw outside the callback path. Such throws can leave `running` incremented and the active entry present. | Async file I/O and catch/finally would fix blocking and stranded-state bugs; those changes must be deferred or separately approved. |
| 44–50 | Chunk completion first attempts temp cleanup (and suppresses cleanup errors), then deletes active state, emits `done(id, err)`, invokes `cb(err, result)`, and finally frees the slot. | Event/callback order and suppressed cleanup errors must be preserved. Listener or callback throws currently prevent later actions. |
| 53–65 | Small-upload completion deletes active state and emits `done` before retry handling or callback. `done` carries no result. Ordinary success/error then calls the callback before freeing the slot. | A uniform completion helper can accidentally alter ordering and reentrancy. |
| 56–62 | A small-upload error with numeric `code === 429` emits `done`, doubles the module-global delay **before** waiting (first wait: 1000 ms), does not call the callback, frees the slot, and later calls `upload()` again from scratch. | Retry must allocate a new ID, reread token/file/meta, and share a delay across instances. It is unbounded and never reset after success. |
| 56–62, 74–77 | During a retry wait no active entry exists. The new ID is not returned to the original caller. Cancelling the original ID cannot stop the timer or retry. | A visible retry state, stable logical ID, or real cancellation changes monitoring behavior. |
| 74–77 | `cancel(id)` only deletes bookkeeping. Queued work, in-flight HTTPS requests, callbacks, events, chunk sequences, and retry timers continue; unknown IDs are ignored. | Abort signals or queue removal are post-migration features, not compatible refactors. |
| 47, 55 | `done` is emitted for send success/errors and for the first 429 attempt, but not for token/stat failures or synchronous setup/I/O throws. | Tests and consumers may rely on this inconsistent event surface. |
| 47–49, 55–64 | Active state is gone before event/callback execution, while `running` is still occupied. Throws from a `done` listener or callback can strand the slot. | Promise/finally cleanup would alter reentrancy and failure behavior. |

### Queue and provider semantics

| Lines | Current behavior / hidden contract | Why it constrains migration |
|---|---|---|
| 69, 79–89 | Queueing is FIFO per instance. Drain starts synchronously from `upload()`, fills up to `concurrency`, and after completion schedules the next drain with `setImmediate`. | A Promise/microtask scheduler or immediate recursive drain changes ordering relative to timers, I/O, and callers. |
| 81–87 | `running` increments before a job and decrements only when its `done` callback runs. Job errors are not passed to the drain. | A generic task pool with automatic `finally` cleanup fixes current slot-leak behavior. |
| 91–96 | A provided token provider is invoked as `this.tokenProvider(cb)` and may invoke its callback synchronously. Its return value is passed through from `_readToken`; thrown errors and duplicate callbacks are not guarded. | Wrapping it directly in a Promise changes sync timing and may hide malformed-provider behavior. |
| 93–96 | File token loading is asynchronous UTF-8, trims both ends, and accepts an empty token. | Caching, validation, or preserving whitespace changes authorization. |

### HTTP protocol and response behavior

| Lines | Current behavior / hidden contract | Why it constrains migration |
|---|---|---|
| 99–108 | Every request is HTTPS `POST /v2/assets` to the module-captured host. Headers are bearer token, MD5 body digest, JSON metadata, and exact body length; there is no content type. | Algorithm, endpoint, metadata encoding, and header presence are server contracts. |
| 100–108 | Digesting and `JSON.stringify(meta || {})` happen synchronously. Falsy metadata becomes `{}`. Circular data, `BigInt`, invalid header values, or request-construction failures can throw rather than reach the callback. | Eager validation/error conversion would change failure channels and timing. |
| 109–118 | The full response is accumulated as a string with no size limit. Any status below 300 is accepted; `>=300` fails. Successful invalid/empty JSON becomes `{raw: out}` rather than an error. | Streaming parsing, 2xx narrowing, redirects, or strict JSON parsing is incompatible. |
| 113–114 | Exactly status 429 creates `Error('rate limited')` with numeric `code = 429` and discards its body. Other failures use `Error('upload failed: <status> <body>')` without a status code field. | Structured HTTP errors would change retry detection and error text/shape. |
| 119–121 | Only request `error` is handled. There is no timeout, abort, response `error`/`aborted` handling, callback-once guard, agent option, or body limit. A stalled/broken response can occupy a slot indefinitely. | Reliability fixes affect externally visible termination and must not ride with migration. |

### Chunked path

| Lines | Current behavior / hidden contract | Why it constrains migration |
|---|---|---|
| 40–46, 124–146 | A large source is synchronously copied to `<tmpDir>/<id>.part`; a crash can leave it behind, a pre-existing file is overwritten, and partial remote uploads are never cleaned up. | Direct source streaming or cleanup recovery changes snapshot and failure behavior. |
| 124–143 | Chunks are exactly 8 MiB, sent strictly sequentially, each through the ordinary endpoint with its own MD5 digest and response handling. There is no finalization request. | Parallel chunks or a distinct multipart protocol is incompatible. |
| 127, 131 | Upload ID is 8 random bytes in lowercase hex. Final success is synthesized locally as `{uploadId, size}` rather than using server response data. | ID format and result shape are observable. |
| 133–136 | Each chunk allocates a zero-filled buffer, synchronously opens/reads/closes the file, and ignores the read byte count. A short read can send zero-filled bytes; a thrown read can leak the descriptor. | Async streams and exact-read checks intentionally fix quirks. |
| 137–139 | Metadata is shallow-cloned per chunk; reserved `uploadId`, `offset`, and `total` overwrite caller values. Metadata is evaluated at each chunk, so nested mutations remain visible. | Deep cloning or rejecting reserved keys changes requests. |
| 139–145 | First chunk error ends the job; 429 is not retried on this path. With a synchronously-callbacking test double, recursive `next()` can grow the stack. | Sharing small-file retry logic or replacing sequencing wholesale changes behavior. |
| 40–44, 131–139 | The original stat size controls copy processing and chunk count. If the source changes during the copy, the copied file's actual size is not restatted; trailing data may be ignored or short reads zero-filled. | Rechecking size improves correctness but changes race outcomes. |

## Stepwise migration plan

Each step is a separate release-sized change. Keep the legacy implementation available and default-selected until Step 7. Reverting a step means reverting that release's change only; persisted data/protocol changes are not introduced.

### 1. Freeze the observable contract with characterization tests — S

**Change:** Add a deterministic test harness around the untouched module. Isolate the module cache and fake filesystem, HTTPS request/response streams, random bytes, clock, `setTimeout`, and `setImmediate`. Capture an ordered trace of return values, active-map snapshots, requests, events, callbacks, queue counters, and scheduled work.

**Coverage:** Constructor/default/singleton behavior; overloads and no-callback calls; FIFO/concurrency; sync and async token providers; all error paths; 64 MiB boundary; metadata failures/mutation; response parsing/statuses; both upload modes; retries across instances; cancellation in queued/in-flight/retry states; throwing listeners/callbacks; reset limitations; cwd/host capture.

**Risk:** Tests may accidentally encode harness artifacts rather than runtime behavior.

**Compatibility proof:** Run fixtures against the untouched file first and save reviewed semantic traces (not timing sleeps). Include a small set of integration tests using real temporary files and a local TLS endpoint to validate the fakes. Production code remains unchanged, so this step is trivially revertible.

### 2. Add build/type scaffolding without changing the runtime entry point — S

**Change:** Introduce strict TypeScript configuration for new internal files and a declaration file describing the actual CommonJS API, including optional callback, numeric 429 code, event signature, mutable active-record export, permissive options, and synchronous ID return. Type-check representative call-site shapes without editing those sites.

**Risk:** Types may falsely narrow intentionally permissive runtime inputs.

**Test strategy:** Compile/type tests plus the full Step 1 suite against the original runtime file.

**Compatibility proof:** Compare the packaged module path and exported keys/identities before and after; runtime bytes for the implementation remain unchanged.

### 3. Introduce internal dependency seams in legacy JavaScript — M

**Change:** With no public export changes, route built-ins through a private dependency record whose defaults are the exact current `fs`, `https`, `crypto`, clock, scheduler, environment, and cwd behavior. Preserve module-evaluation host capture and dynamic token cwd. Expose injection only through a test-only loading mechanism, not `getUploader(opts)`.

**Risk:** Capturing dependencies at the wrong time or losing method binding can change monkey-patching, cwd, host, and token-provider semantics.

**Test strategy:** Run every characterization fixture once with defaults and once with injected equivalents; retain local TLS integration tests.

**Compatibility proof:** Ordered traces must be byte-for-byte equal after normalizing nondeterministic timestamp/random fields. Also verify the production export key list, function arity, prototype chain, singleton identity, and `activeUploads` identity.

### 4. Implement a side-by-side typed candidate, not used in production — L

**Change:** Build a typed internal core behind a compatibility adapter. Use `async`/`await` only behind boundaries proven already asynchronous. Retain callback-style shells for synchronous ID allocation, queue draining, potentially synchronous token providers, `setImmediate` scheduling, event/callback order, and synchronous throw channels. Deliberately reproduce global IDs/retry state, active-map identity, threshold/protocol details, retry asymmetry, and synthetic chunk result.

**Risk:** Promise microtasks, automatic exception propagation, and `finally` blocks can silently fix timing, slot leaks, or callback behavior.

**Test strategy:** Differentially run legacy and candidate implementations from fresh module contexts over the same scripted dependency transcript. Fail on any difference in ordered effects, callback arguments/error messages, request bytes/headers, event order, scheduler choice, or exposed state.

**Compatibility proof:** Candidate must pass the legacy golden traces and differential matrix with zero unexplained deltas. Any behavior that cannot be reproduced with `async`/`await` stays in the compatibility shell and is documented; syntax conversion is not allowed to trump behavior.

### 5. Add a stable facade and dormant release switch — M

**Change:** Keep the existing import path and CommonJS export shape. Behind it, select one complete implementation once at module evaluation. Default to legacy. The switch is internal, packaged, and release-configured; it must not be influenced by later `getUploader()` calls. Both selections must export the same active object and preserve singleton/global-state semantics.

**Risk:** A wrapper can add stack frames, alter require-cache behavior, duplicate module globals, or produce two singleton/state universes.

**Test strategy:** Run the full suite in both selections, plus module-cache/reset tests and packaged Electron smoke tests. Test switching only across fresh process starts, never in-process.

**Compatibility proof:** Export descriptors, identities, prototypes, IDs, traces, and outbound protocol match. Legacy remains the default and immediate rollback requires only reverting the release flag.

### 6. Opt in internal/pre-release cohorts — M

**Change:** Select the candidate only in development, CI, and a small pre-release cohort. Record aggregate completion/error/status/latency and stranded-queue counts without logging tokens, metadata, file paths, response bodies, or changing uploader control flow. Do not dual-send or shadow uploads.

**Risk:** Instrumentation itself can perturb event order or expose sensitive data; rare filesystem races may be missed.

**Test strategy:** Packaged-app tests with concurrent small/large uploads, rate limits, network faults, restarts, cwd changes, and multiple uploader instances. Compare aggregate legacy/candidate outcomes across equivalent cohorts.

**Compatibility proof:** Differential tests remain gating; cohort metrics show no unexplained change in request count, status/error distribution, callback/event completion, retry count, or queue stalls. Disable candidate selection to abort.

### 7. Make the candidate the default, retain one-release fallback — S

**Change:** Flip only the release selection. Keep the legacy implementation packaged and selectable for at least one normal release.

**Risk:** Scale-dependent global retry coupling, long-lived responses, or external mutation of `activeUploads` may surface only in production.

**Test strategy:** Staged rollout with the Step 6 aggregate checks and rollback threshold for unexplained request-count, error, retry, or completion changes.

**Compatibility proof:** Same build can return to legacy selection on restart; no call-site or persisted-state rollback is needed.

### 8. Remove the fallback after a full stable release — S

**Change:** After the rollback window and explicit sign-off, remove legacy selection and dead differential plumbing, but retain characterization tests and the compatibility adapter/API.

**Risk:** Removal ends instant fallback and may accidentally remove fixtures that document quirks.

**Test strategy:** Full suite, packaged smoke test, and artifact inspection confirming one implementation with the unchanged entry point/exports.

**Compatibility proof:** Candidate traces remain equal to the frozen baseline. Revert of this step alone restores the packaged fallback.

## Explicit non-goals and deliberate traps

During migration, do **not**:

- change the public API to Promises, add a second public API, alter callback optionality, or edit all call sites;
- make cancellation real, keep one ID across retries, expose retry-wait state, or suppress post-cancel callbacks/events;
- reset/cap/jitter the global retry delay, honor `Retry-After`, retry chunked 429s, or normalize error objects;
- stream small files, parallelize chunks, alter the 64 MiB/8 MiB boundaries, change MD5, add finalization, or use server data for chunk completion;
- make file I/O nonblocking, repair short reads, restat copied files, validate regular files, recursively create temp directories, or clean stale/remote partials;
- add timeouts, response-abort handling, body limits, strict JSON parsing, redirects, content type, or callback-once guards;
- clone/freeze metadata, reserve metadata keys, validate options/tokens, change cwd/host capture, or honor later singleton options;
- replace the exported active object, improve `_resetForTests()`, restore the prototype constructor, or automatically recover slots after thrown callbacks/listeners;
- shadow production uploads, because duplicate asset creation is not a safe comparison technique;
- combine migration with queue-library adoption, protocol redesign, telemetry platform work, or broad call-site cleanup.

### Follow-up tickets after compatibility migration

1. Design a versioned Promise API and migrate call sites separately.
2. Implement true queued/in-flight/retry cancellation with request aborts and stable logical IDs.
3. Replace global unbounded retry state with per-job capped exponential backoff, jitter, `Retry-After`, and chunk retry policy.
4. Move filesystem work off the main thread; stream bodies/chunks; verify exact reads and copied-file size.
5. Add request/response timeouts, aborted/error handling, body limits, and callback-once protection.
6. Make completion signaling consistent and exception-safe; define event/callback ordering as a supported contract.
7. Harden temp lifecycle: recursive/atomic directory setup, collision policy, startup cleanup, and remote partial cleanup.
8. Validate options, tokens, regular files, metadata serialization/size, and reserved chunk keys.
9. Replace MD5 only through a server-coordinated protocol version.
10. Remove mutable global exports/singleton option ambiguity and provide an explicit diagnostics interface.
11. Improve test reset to isolate counters, retries, timers, active state, and in-flight work.
12. Add safe operational telemetry with a documented data-handling policy.

## Estimates and critical path

| Step | Size | Depends on |
|---|---:|---|
| 1. Characterization suite | S | — |
| 2. Build/type scaffolding | S | 1 |
| 3. Legacy dependency seams | M | 1 |
| 4. Typed side-by-side candidate | L | 2, 3 |
| 5. Stable facade/dormant switch | M | 4 |
| 6. Pre-release cohorts | M | 5 |
| 7. Candidate default with fallback | S | 6 |
| 8. Remove fallback | S | one stable release after 7 |

**Critical path:** 1 → 3 → 4 → 5 → 6 → 7 → one-release soak → 8. Step 2 can overlap the latter part of Step 3, but both gate Step 4. The largest engineering item is Step 4; the calendar constraint is the cohort and fallback soak. Steps 1–6 may ship with legacy still selected, so the team can stop at any boundary without forcing a production behavior change.