# Undoable React Store

## What was built

- A generic `createUndoableStore<T>(initial)` external store with `get`, `set`, ordered subscriptions, undo, redo, availability checks, and a 100-entry undo cap.
- Redo-branch invalidation after a new committed update.
- Nested transactions that join the outer transaction and produce one history entry and one notification.
- A descriptive guard against store mutation during component rendering.
- `useStore(selector, isEqual?)`, with selector-level snapshot caching so unrelated updates do not re-render consumers and selector identity changes do not resubscribe.
- `useUndoRedo()`, whose snapshot is only the two history-availability flags, so ordinary updates do not re-render it while those flags remain unchanged.
- Tests covering history behavior, cap enforcement, redo invalidation, valid `undefined` state, nested transactions, subscriber ordering, selective renders, custom equality, selector stability, history-hook renders, and render-phase mutation.

Both hooks use `useSyncExternalStore`. React reads the external snapshot while rendering and verifies it again before committing; if the store changed in between, React retries with the current snapshot. This is the supported mechanism for keeping external stores consistent during concurrent rendering and avoiding tearing.

## How to verify

```sh
npm test
npm run typecheck
```

Equivalent required commands:

```sh
npx vitest run
npx tsc --noEmit
```

## Final output tails

`npx vitest run`:

```text
Test Files  1 passed (1)
     Tests  10 passed (10)
  Duration  375ms (transform 18ms, setup 0ms, import 53ms, tests 18ms, environment 222ms)
```

`npx tsc --noEmit`:

```text
TypeScript check passed with zero errors.
```

## Limitations

- State snapshots are retained by reference; callers should return new immutable values rather than mutating stored objects in place.
- React does not expose a public render-phase query. The mutation guard therefore supports the installed React runtime through its dispatcher marker and keeps the guard active through same-turn development error replays.
- `undo()` and `redo()` intentionally throw inside an active transaction because mixing history traversal into a transaction has ambiguous commit semantics.
