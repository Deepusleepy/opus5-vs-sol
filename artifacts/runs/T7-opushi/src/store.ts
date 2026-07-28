import * as React from "react";
import { assertNotRendering } from "./render-guard.js";
import { useStoreSlice } from "./use-store-slice.js";

/** Maximum number of undo steps retained. Older entries are dropped. */
export const HISTORY_LIMIT = 100;

export type Updater<T> = T | ((previous: T) => T);

/** Immutable pair of history flags. Identity changes only when a flag flips. */
export interface HistoryFlags {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface UndoRedoControls extends HistoryFlags {
  readonly undo: () => void;
  readonly redo: () => void;
}

export interface UndoableStore<T> {
  /** Current value. Safe to call at any time, including during render. */
  get(): T;
  /** Replace the value. Throws if called during render. */
  set(updater: Updater<T>): void;
  /**
   * Register a listener, called after every committed change. Listeners run in
   * subscription order. Returns an unsubscribe function; calling it twice is a
   * no-op. Subscribing or unsubscribing from inside a listener is safe and
   * takes effect on the next notification.
   */
  subscribe(listener: (value: T) => void): () => void;
  /**
   * Run `fn`, collapsing every `set` inside it into ONE history entry and ONE
   * round of notifications. Nested calls join the outermost transaction. If
   * `fn` throws, the value is rolled back to what it was when the outermost
   * transaction began, no history entry is written, and no listener runs.
   */
  transact(fn: () => void): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * Subscribe a component to a slice of the value. Re-renders only when the
   * slice changes (`Object.is`, or `isEqual` when supplied). Changing the
   * identity of `selector` or `isEqual` never resubscribes.
   */
  useStore<S>(selector: (value: T) => S, isEqual?: (a: S, b: S) => boolean): S;
  /**
   * `{ undo, redo, canUndo, canRedo }`. Re-renders the component only when a
   * can-flag flips, not on every store change.
   */
  useUndoRedo(): UndoRedoControls;
}

export function createUndoableStore<T>(initial: T): UndoableStore<T> {
  let value = initial;
  /** Previous values, oldest first. `past.length` is the available undo depth. */
  const past: T[] = [];
  /** Values undone away from; `redo` pops the most recent. */
  const future: T[] = [];
  const listeners = new Set<(value: T) => void>();

  /** Depth of the open transaction; 0 means none is open. */
  let depth = 0;
  /** Value when the outermost open transaction began. Read only while open. */
  let baseline: T = initial;

  let flags: HistoryFlags = { canUndo: false, canRedo: false };

  /** Refresh the cached flags object, then run listeners in insertion order. */
  function notify(): void {
    const canUndoNow = past.length > 0;
    const canRedoNow = future.length > 0;
    // Recomputed *before* listeners run: `useUndoRedo` reads `flags` from a
    // React store-change callback that fires inside the loop below.
    if (canUndoNow !== flags.canUndo || canRedoNow !== flags.canRedo) {
      flags = { canUndo: canUndoNow, canRedo: canRedoNow };
    }
    // Iterate a copy so a listener may (un)subscribe without disturbing this pass.
    for (const listener of [...listeners]) listener(value);
  }

  /** Record the move away from `previous` as one history entry, then notify. */
  function commit(previous: T): void {
    past.push(previous);
    if (past.length > HISTORY_LIMIT) past.shift();
    future.length = 0; // any new change invalidates the redo branch
    notify();
  }

  function assertNoOpenTransaction(method: string): void {
    if (depth === 0) return;
    throw new Error(
      `[undoable-store] ${method} cannot be called inside transact(): the ` +
        `open transaction has not produced a history entry yet.`,
    );
  }

  function get(): T {
    return value;
  }

  function set(updater: Updater<T>): void {
    assertNotRendering("set()");
    const next =
      typeof updater === "function"
        ? (updater as (previous: T) => T)(value)
        : updater;
    if (depth > 0) {
      // Inside a transaction: defer history and notification to the outermost
      // `transact`, so N sets become one entry and one notification.
      value = next;
      return;
    }
    const previous = value;
    if (Object.is(previous, next)) return; // no-op: no entry, no notification
    value = next;
    commit(previous);
  }

  function transact(fn: () => void): void {
    assertNotRendering("transact()");
    if (depth > 0) {
      // Nested: join the outer transaction — no commit, no rollback of its own.
      depth += 1;
      try {
        fn();
      } finally {
        depth -= 1;
      }
      return;
    }
    depth = 1;
    baseline = value;
    try {
      fn();
    } catch (error) {
      value = baseline;
      depth = 0;
      throw error;
    }
    depth = 0;
    if (Object.is(baseline, value)) return; // net no-op across the transaction
    commit(baseline);
  }

  function undo(): void {
    assertNotRendering("undo()");
    assertNoOpenTransaction("undo()");
    if (past.length === 0) return;
    // Length-checked above, so this entry exists even when `T` includes undefined.
    const previous = past.pop() as T;
    future.push(value);
    value = previous;
    notify();
  }

  function redo(): void {
    assertNotRendering("redo()");
    assertNoOpenTransaction("redo()");
    if (future.length === 0) return;
    const next = future.pop() as T;
    past.push(value);
    value = next;
    notify();
  }

  function canUndo(): boolean {
    return past.length > 0;
  }

  function canRedo(): boolean {
    return future.length > 0;
  }

  // One stable identity for the lifetime of the store. Passing this straight to
  // `useSyncExternalStore` is what guarantees React never resubscribes, however
  // often the caller's selector identity changes.
  const subscribe = (listener: (value: T) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getFlags = (): HistoryFlags => flags;

  /** The read surface handed to `useStoreSlice`; stable for the store's life. */
  const readable = { get, subscribe };

  function useStore<S>(
    selector: (value: T) => S,
    isEqual?: (a: S, b: S) => boolean,
  ): S {
    return useStoreSlice(readable, selector, isEqual);
  }

  function useUndoRedo(): UndoRedoControls {
    // `getFlags` returns a cached object whose identity changes only when a
    // flag flips, so React's own Object.is check skips the re-render on every
    // other store change. No selector caching is needed for that.
    const current = React.useSyncExternalStore(subscribe, getFlags, getFlags);
    return React.useMemo(
      () => ({
        undo,
        redo,
        canUndo: current.canUndo,
        canRedo: current.canRedo,
      }),
      [current],
    );
  }

  return {
    get,
    set,
    subscribe,
    transact,
    undo,
    redo,
    canUndo,
    canRedo,
    useStore,
    useUndoRedo,
  };
}
