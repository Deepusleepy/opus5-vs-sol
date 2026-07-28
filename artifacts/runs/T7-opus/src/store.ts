import * as React from "react";

export type Listener = () => void;
export type Updater<T> = (prev: T) => T;

export interface UndoableStore<T> {
  /** Current value. Safe to call anywhere, including during render. */
  get(): T;
  /** Apply a new value (or an updater function). Throws if called during render. */
  set(updater: Updater<T> | T): void;
  /** Register a listener; returns an unsubscribe function. Listeners fire in registration order. */
  subscribe(listener: Listener): () => void;
  /** Run `fn`, collapsing every `set` inside it into one history entry and one notification. */
  transact(fn: () => void): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

/** Maximum number of undo steps retained; older entries are dropped. */
export const MAX_HISTORY = 100;

/**
 * Detects whether we are inside a React render pass.
 *
 * Two independent signals from React's shared internals, OR-ed together:
 *
 *  - The hook dispatcher (`H`). React swaps in a real dispatcher for the
 *    duration of a component's render; outside render it leaves a "context
 *    only" dispatcher whose hook methods are all the *same* function (the one
 *    that throws "invalid hook call"). So "two hooks are distinct
 *    implementations" means we are rendering, and the check stays correct in
 *    effects and event handlers where the dispatcher is non-null but inert.
 *  - The async/cache dispatcher (`A`), which React installs for the whole
 *    render pass and clears afterwards. This one also covers the DEV-only
 *    replay React performs when a component throws (that replay runs with a
 *    null hook dispatcher), so a render-phase write still throws on every
 *    attempt instead of sneaking through on the replay.
 *
 * The older React 18 dispatcher field is read as a fallback. On an
 * unrecognised build no signal is present and the guard simply never fires,
 * which degrades to today's silent-bug behaviour rather than false positives.
 */
type Dispatcher = Record<string, unknown> | null | undefined;
interface Internals {
  H?: Dispatcher;
  A?: unknown;
  ReactCurrentDispatcher?: { current: Dispatcher };
}

function isRenderDispatcher(dispatcher: Dispatcher): boolean {
  return dispatcher != null && dispatcher["useState"] !== dispatcher["useEffect"];
}

function isRendering(): boolean {
  const react = React as unknown as Record<string, Internals | undefined>;
  const modern = react["__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"];
  if (modern != null && (modern.A != null || isRenderDispatcher(modern.H))) return true;
  const legacy = react["__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED"];
  return isRenderDispatcher(legacy?.ReactCurrentDispatcher?.current);
}

function assertNotRendering(method: string): void {
  if (isRendering()) {
    throw new Error(
      `createUndoableStore: ${method}() was called during a React render. ` +
        `Mutating a store while rendering makes the render impure and can tear the UI. ` +
        `Move the call into an event handler, an effect, or other non-render code.`,
    );
  }
}

export function createUndoableStore<T>(initial: T): UndoableStore<T> {
  let value: T = initial;
  const past: T[] = [];
  let future: T[] = [];
  const listeners = new Set<Listener>();
  let depth = 0;

  const notify = (): void => {
    // Copy so that unsubscribing (or subscribing) from a listener cannot
    // disturb the iteration. Registration order is preserved.
    for (const listener of [...listeners]) listener();
  };

  /** Push `previous` onto the undo stack and invalidate the redo branch. */
  const pushHistory = (previous: T): void => {
    past.push(previous);
    if (past.length > MAX_HISTORY) past.shift();
    future = [];
  };

  const get = (): T => value;

  const set = (updater: Updater<T> | T): void => {
    assertNotRendering("set");
    const next =
      typeof updater === "function" ? (updater as Updater<T>)(value) : updater;
    if (Object.is(next, value)) return;
    if (depth > 0) {
      // Inside a transaction: only the outermost `transact` records history
      // and notifies.
      value = next;
      return;
    }
    pushHistory(value);
    value = next;
    notify();
  };

  const transact = (fn: () => void): void => {
    assertNotRendering("transact");
    if (depth > 0) {
      // Nested: join the outer transaction.
      depth += 1;
      try {
        fn();
      } finally {
        depth -= 1;
      }
      return;
    }
    const before = value;
    depth = 1;
    try {
      fn();
    } catch (error) {
      // Atomic: a throwing transaction leaves the store untouched.
      value = before;
      depth = 0;
      throw error;
    }
    depth = 0;
    if (Object.is(value, before)) return;
    pushHistory(before);
    notify();
  };

  const undo = (): void => {
    assertNotRendering("undo");
    if (depth > 0) throw new Error("createUndoableStore: undo() cannot be called inside transact().");
    if (past.length === 0) return;
    const previous = past[past.length - 1] as T;
    past.length -= 1;
    future.push(value);
    value = previous;
    notify();
  };

  const redo = (): void => {
    assertNotRendering("redo");
    if (depth > 0) throw new Error("createUndoableStore: redo() cannot be called inside transact().");
    if (future.length === 0) return;
    const next = future[future.length - 1] as T;
    future.length -= 1;
    past.push(value);
    if (past.length > MAX_HISTORY) past.shift();
    value = next;
    notify();
  };

  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    get,
    set,
    subscribe,
    transact,
    undo,
    redo,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}
