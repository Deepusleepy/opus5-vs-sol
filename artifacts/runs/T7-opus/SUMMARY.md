# T7 — Headless undoable store + React bindings

A logic-only state library: an external undoable store usable without React, plus
`useSyncExternalStore`-based hooks. No components, no DOM, no styling.

## What I built

Three source files, ~200 lines total.

### `src/store.ts` — `createUndoableStore<T>(initial: T)`

Plain closure over `value`, a `past: T[]` stack, a `future: T[]` stack, and an ordered
`Set` of listeners. Fully usable outside React.

| API | Behaviour |
| --- | --- |
| `get()` | Current value. Safe during render. |
| `set(updater \| value)` | Applies the change; no-op when `Object.is(next, prev)`. Throws during render. |
| `subscribe(cb)` | Returns an unsubscribe function. Listeners fire in registration order. |
| `transact(fn)` | Collapses every `set` inside `fn` into one history entry and one notification. |
| `undo()` / `redo()` | Move between stacks and notify once. No-ops at the ends of history. |
| `canUndo()` / `canRedo()` | Stack-depth predicates. |

- **History cap (`MAX_HISTORY = 100`).** Pushing past the cap shifts the oldest entry off,
  so after 150 sets exactly 100 undos are available and the oldest reachable value is the
  50th. The cap is enforced on `redo`'s push too, so bouncing back and forth cannot grow
  the stack past 100.
- **Redo-branch invalidation.** Any new `set` or committed `transact` clears `future`.
- **Nested transactions join the outer one.** A depth counter tracks nesting; only the
  outermost `transact` snapshots the pre-transaction value, pushes history, and notifies.
  Inner `set` calls write straight to `value`, so `get()` inside a transaction sees the
  in-progress state.
- **Transactions are atomic.** If the body throws, `value` is restored to the
  pre-transaction snapshot, no history is recorded, no listener fires, and the error is
  rethrown. `undo`/`redo` inside a transaction throw rather than corrupting the stacks.
- **Notification is iteration-safe.** Listeners are copied before dispatch, so a listener
  that unsubscribes (or subscribes) mid-notification cannot skip a sibling.

### The render-phase write guard

`set`, `transact`, `undo`, and `redo` throw a descriptive error when called during render.
Detection reads React's shared internals and OR-s two signals:

1. **Hook dispatcher `H`.** During render React installs a real dispatcher; outside render
   it leaves a "context only" dispatcher whose hook methods are *all the same function*
   (the invalid-hook-call thrower). So `useState !== useEffect` means "rendering" — and
   critically, it stays `false` inside effects and event handlers, where the dispatcher is
   non-null but inert. A naive `H != null` check produces false positives there; I verified
   this empirically before settling on the identity comparison.
2. **Async/cache dispatcher `A`**, which is installed for the whole render pass. This
   covers React DEV's replay of a throwing component, which re-invokes the function with a
   *null* hook dispatcher. Without signal 2, the write would sneak through on that replay
   and mutate the store even though the render errored.

The React 18 `ReactCurrentDispatcher` field is read as a fallback. On an unrecognised build
no signal is present and the guard simply never fires — degrading to the ordinary silent
bug rather than throwing spuriously.

### `src/hooks.ts` — `createStoreHooks(store)`

- **`useStore(selector, isEqual?)`.** `getSnapshot` is a `useCallback(…, [])` — permanently
  stable — that reads the selector and comparator out of refs updated on every render. It
  caches the last slice and returns the *cached reference* when `isEqual` (default
  `Object.is`) says nothing changed, which is what makes `useSyncExternalStore` skip the
  re-render. Because both `subscribe` and `getSnapshot` are stable, a new selector arrow on
  every render never triggers a resubscribe and never causes a render loop, yet a selector
  that changes *behaviour* takes effect on the very next render.
- **`useUndoRedo()`.** Same caching shape over `{undo, redo, canUndo, canRedo}`: the object
  keeps its identity until a boolean flag actually flips, so a component wired to undo
  buttons re-renders on the first edit and on the first undo, not on every store write.

### Why `useSyncExternalStore` is tearing-safe

Tearing is when a concurrent render is interrupted, the external store changes during the
interruption, and the resumed render reads the new value — leaving two components in one
committed tree showing different versions of the same data.

`useSyncExternalStore` prevents this because React treats it as a special hook rather than
as ordinary state:

1. **Every read goes through `getSnapshot`, and React re-reads it at the end of the render
   pass.** If the snapshot returned during render differs from the one at commit time,
   React discards the work and re-renders synchronously from the top, so the committed tree
   is built from a single consistent store version.
2. **Store-driven updates are never time-sliced.** The subscription's update is scheduled at
   sync priority, so it cannot be partially applied across a yield boundary the way a
   `startTransition` update can.
3. **The store owns the value; React never caches a stale copy.** With `useState` +
   `useEffect` the value is mirrored into React state and can lag behind the source. Here
   React holds no copy — it re-reads the source, which is why the "external mutable source"
   problem is solved rather than merely narrowed.

The third argument (`getServerSnapshot`) is the same function, correct here because the
store is fully client-side and has no separate hydration value.

## How to verify

```
cd <project-root>
npm install         # deps are already installed
npx tsc --noEmit    # zero errors
npx vitest run      # 33 tests, 3 files
```

### `npx tsc --noEmit`

No output; exit code 0.

```
$ npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

### `npx vitest run`

```
 RUN  v4.1.10 <project-root>

 Test Files  3 passed (3)
      Tests  33 passed (33)
   Start at  08:39:04
   Duration  433ms (transform 71ms, setup 0ms, import 171ms, tests 42ms, environment 768ms)
```

<details>
<summary>Full test list (<code>--reporter=verbose</code>)</summary>

```
 ✓ tests/store.test.ts > basic store > gets and sets
 ✓ tests/store.test.ts > basic store > ignores sets that produce the identical value
 ✓ tests/store.test.ts > basic store > unsubscribes
 ✓ tests/store.test.ts > history > undoes and redoes
 ✓ tests/store.test.ts > history > is a no-op at the ends of history
 ✓ tests/store.test.ts > history > invalidates the redo branch on a new set after undo
 ✓ tests/store.test.ts > history > invalidates the redo branch on a transaction after undo
 ✓ tests/store.test.ts > history > caps history at 100 entries, dropping the oldest
 ✓ tests/store.test.ts > history > keeps the cap while redoing back and forth
 ✓ tests/store.test.ts > transactions > collapses many sets into one history entry and one notification
 ✓ tests/store.test.ts > transactions > joins nested transactions into the outer one
 ✓ tests/store.test.ts > transactions > reads the in-progress value inside a transaction
 ✓ tests/store.test.ts > transactions > records nothing when a transaction makes no net change
 ✓ tests/store.test.ts > transactions > rolls back and rethrows when the transaction body throws
 ✓ tests/store.test.ts > transactions > rejects undo/redo inside a transaction
 ✓ tests/store.test.ts > external subscriber ordering > notifies listeners in registration order, once per commit
 ✓ tests/store.test.ts > external subscriber ordering > survives a listener unsubscribing during notification
 ✓ tests/concurrent.test.tsx > StrictMode > stays correct under double-invoked renders and remounted effects
 ✓ tests/concurrent.test.tsx > concurrent features > shows one consistent value across siblings when a transition is interrupted
 ✓ tests/concurrent.test.tsx > concurrent features > does not tear when the store changes between the two reads of a render pass
 ✓ tests/hooks.test.tsx > useStore > renders the selected slice and updates on change
 ✓ tests/hooks.test.tsx > useStore > re-renders only when the selected slice changes
 ✓ tests/hooks.test.tsx > useStore > honours a custom isEqual for referentially-unstable slices
 ✓ tests/hooks.test.tsx > useStore > does not resubscribe when the selector identity changes
 ✓ tests/hooks.test.tsx > useStore > collapses a transaction into a single re-render
 ✓ tests/hooks.test.tsx > useStore > unsubscribes on unmount
 ✓ tests/hooks.test.tsx > useUndoRedo > re-renders only when a can-flag flips
 ✓ tests/hooks.test.tsx > useUndoRedo > exposes working undo/redo callbacks
 ✓ tests/hooks.test.tsx > render-phase writes > throws a descriptive error when set is called during render
 ✓ tests/hooks.test.tsx > render-phase writes > throws when transact is called during render
 ✓ tests/hooks.test.tsx > render-phase writes > allows set from effects and event handlers
 ✓ tests/hooks.test.tsx > render-phase writes > allows get during render
 ✓ tests/hooks.test.tsx > multiple components > keeps independent subscribers consistent
```

</details>

### Test design notes

Re-render assertions use exact counters (`expect(renders).toBe(2)`), not "at least"
thresholds, so an over-rendering regression fails rather than passing quietly. I spot-checked
this by mutating the source: disabling the slice cache and un-stabilising `subscribe` each
turned the corresponding test red, confirming the assertions bite.

`tsconfig.json` is strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noUnusedLocals`/`Parameters`, `verbatimModuleSyntax`, and `isolatedModules`.

## Limitations

- **The render guard depends on React internals.** `__CLIENT_INTERNALS_…` is unstable by
  design and could change shape in a future React release. The failure mode is chosen to be
  safe — an unrecognised shape disables the guard rather than producing false positives —
  but it is a DEV-ergonomics feature, not a correctness invariant, and it is not stripped
  from production builds (the check is two property reads, so the cost is negligible).
- **History stores whole snapshots, not diffs.** Simple and correct for the plain-object
  state these stores are meant for; 100 snapshots of a large state tree is real memory.
  Structural sharing via immutable updaters keeps this cheap in practice, but a
  patch/command-based history would be the right call for genuinely large documents.
- **"Collaborative" here means multi-subscriber, not multi-user.** There is no CRDT, no OT,
  no network transport, and no per-user history partitioning. Concurrent remote edits would
  need conflict resolution the store does not attempt.
- **No middleware, devtools, persistence, or async-action layer.** Deliberately omitted;
  `subscribe` is the extension point, and anything else can be built on top without the
  library knowing.
- **`transact` is synchronous only.** An `await` inside the body would let the transaction
  close before the later writes land. Not enforced at runtime; an async body would need an
  explicit begin/commit API.
- **Tearing tests are indicative, not exhaustive.** jsdom plus `act()` cannot reliably force
  React to interrupt a render mid-pass, so the concurrent tests demonstrate consistency
  under transitions and StrictMode rather than proving the interleaving that would tear a
  naive implementation. The guarantee rests on `useSyncExternalStore`'s contract.
- **jsdom, single React version.** Tests run against React 19 in jsdom only; the React 18
  fallback path in the guard is code-reviewed, not exercised by a test.
