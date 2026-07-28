# Summary

## What was built

- A headless `createUndoableStore<T>(initial)` external store with `get`, updater-or-value `set`, ordered subscriptions, `undo`, `redo`, capability checks, and a 100-entry undo-history limit.
- Redo-branch invalidation when a new state is committed after an undo.
- Nested transactions that join the outer transaction and produce at most one history entry and one subscriber notification.
- A render-phase mutation guard with a descriptive error and protection for development render replays.
- A selector-aware `useStore(selector, isEqual?)` hook. It keeps the subscription function stable when selector identity changes and preserves the previous selected reference when equality succeeds.
- A `useUndoRedo()` hook whose snapshot contains only the two capability flags, so ordinary state changes with unchanged flags do not re-render consumers.
- Strict TypeScript configuration and ten jsdom tests covering the required history, transaction, subscription, hook, render-count, selector-stability, and render-mutation behavior.

## Concurrent-render safety

Both hooks use `useSyncExternalStore`. React controls snapshot reads and checks them again around concurrent rendering before committing. That protocol prevents a component from committing a stale or torn view that could occur with an effect-based subscription.

## How to verify

Run either the combined gate:

```sh
npm run check
```

Or the two required commands:

```sh
npx vitest run
npx tsc --noEmit
```

## Verification output tails

`npx vitest run`:

```text
✓ test/store.test.tsx (10 tests) 18ms

Test Files  1 passed (1)
     Tests  10 passed (10)
  Duration  366ms
```

`npx tsc --noEmit`:

```text
(no output; exit code 0)
```

## Limitations

- State-change detection uses `Object.is`; callers should return a new state reference for immutable updates. A custom selector equality function can further reduce hook re-renders.
- The render-phase guard targets the installed React 18 major and uses its internal current-render markers because React has no public API for detecting arbitrary external-store mutation during render.
- `undo()` and `redo()` are rejected inside `transact()` to keep a transaction atomic. If a transaction callback throws after changing state, those changes are still committed as one transaction before the error is rethrown; transactions batch rather than roll back.
