# T7 — React (headless, no UI): undoable collaborative store + hooks

Build a headless React state library (NO components, NO DOM, NO styling — logic only) with tests. You may `npm init -y` and install ONLY: `react`, `react-dom`, `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `vitest`, `@testing-library/react`, `jsdom`. Strict tsconfig.

Spec — `createUndoableStore<T>(initial: T)`:
- External store (usable outside React) with `get()`, `set(updater)`, `subscribe(cb)`, plus history: `undo()`, `redo()`, `canUndo()`, `canRedo()`, with history capped at 100 entries.
- Transactions: `transact(fn)` batches any number of `set` calls into ONE history entry and ONE subscriber notification, even when nested (`transact` inside `transact` joins the outer transaction).
- `set` during render must throw a descriptive error (guard against the classic render-phase mutation bug).
- React bindings via `useSyncExternalStore`: `useStore(selector, isEqual?)` — component re-renders ONLY when the selected slice changes (test with a render counter); selector identity changes must not resubscribe (test it); tearing-safe under concurrent features (document why useSyncExternalStore gives you this).
- `useUndoRedo()` hook exposing `{undo, redo, canUndo, canRedo}` that re-renders only when can-flags flip, not on every store change.

Tests (vitest + @testing-library/react, jsdom): history semantics incl. cap and redo-branch invalidation (new set after undo clears redo stack), nested transactions, selective re-render counts, selector stability, external (non-React) subscriber ordering, error on render-phase set.

All green via `npx vitest run`; zero tsc errors via `npx tsc --noEmit`. Output tails in SUMMARY.md. Everything stays in this directory (npm cache noise aside). `SUMMARY.md`: what you built, how to verify, limitations. No AI model names anywhere. Simplicity counts; unnecessary abstraction counts against you.
