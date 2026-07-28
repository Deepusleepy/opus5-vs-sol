import * as React from "react";

type Listener = () => void;
type Updater<T> = T | ((current: T) => T);
type Equality<T> = (previous: T, next: T) => boolean;

export interface UndoRedoControls {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export interface UndoableStore<T> {
  get: () => T;
  set: (updater: Updater<T>) => void;
  subscribe: (listener: Listener) => () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  transact: <Result>(fn: () => Result) => Result;
  useStore: <Selected>(
    selector: (state: T) => Selected,
    isEqual?: Equality<Selected>,
  ) => Selected;
  useUndoRedo: () => UndoRedoControls;
}

type HookDispatcher = {
  useState: unknown;
  useReducer: unknown;
};

type ReactRenderInternals = {
  ReactCurrentDispatcher?: { current: HookDispatcher | null };
  ReactCurrentOwner?: { current: unknown };
};

const reactInternals = (
  React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?: ReactRenderInternals;
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

const HISTORY_LIMIT = 100;
const RENDER_MUTATION_ERROR =
  "Undoable store state cannot be changed during React render. " +
  "Move the mutation to an event handler or an effect.";

function isReactRendering(): boolean {
  const dispatcher = reactInternals?.ReactCurrentDispatcher?.current;
  const hasActiveHookDispatcher =
    dispatcher != null && dispatcher.useState !== dispatcher.useReducer;

  return (
    reactInternals?.ReactCurrentOwner?.current != null || hasActiveHookDispatcher
  );
}

/**
 * Creates an external store with bounded undo history and React bindings.
 *
 * The hooks use React.useSyncExternalStore rather than effect-based
 * subscriptions. React reads and validates the snapshot around concurrent
 * renders, which prevents a component from committing a torn, stale view.
 */
export function createUndoableStore<T>(initial: T): UndoableStore<T> {
  let current = initial;
  let past: T[] = [];
  let future: T[] = [];
  let transactionDepth = 0;
  let transactionStart = initial;
  let replayingFailedRender = false;
  const listeners = new Set<Listener>();

  const assertMutationAllowed = (): void => {
    if (isReactRendering() || replayingFailedRender) {
      if (!replayingFailedRender) {
        // Development builds replay a failed component once to build its stack.
        // Keep the guard active for that same-turn replay as well.
        replayingFailedRender = true;
        queueMicrotask(() => {
          replayingFailedRender = false;
        });
      }
      throw new Error(RENDER_MUTATION_ERROR);
    }
  };

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const pushPast = (state: T): void => {
    past.push(state);
    if (past.length > HISTORY_LIMIT) {
      past.shift();
    }
  };

  const get = (): T => current;

  const set = (updater: Updater<T>): void => {
    assertMutationAllowed();
    const next =
      typeof updater === "function"
        ? (updater as (value: T) => T)(current)
        : updater;

    if (Object.is(next, current)) {
      return;
    }

    const previous = current;
    current = next;

    if (transactionDepth > 0) {
      return;
    }

    pushPast(previous);
    future = [];
    notify();
  };

  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const canUndo = (): boolean => past.length > 0;
  const canRedo = (): boolean => future.length > 0;

  const assertOutsideTransaction = (operation: "undo" | "redo"): void => {
    if (transactionDepth > 0) {
      throw new Error(`${operation}() cannot run inside transact().`);
    }
  };

  const undo = (): void => {
    assertMutationAllowed();
    assertOutsideTransaction("undo");
    if (past.length === 0) {
      return;
    }

    const previous = past.pop() as T;
    future.push(current);
    current = previous;
    notify();
  };

  const redo = (): void => {
    assertMutationAllowed();
    assertOutsideTransaction("redo");
    if (future.length === 0) {
      return;
    }

    const next = future.pop() as T;
    pushPast(current);
    current = next;
    notify();
  };

  const transact = <Result>(fn: () => Result): Result => {
    assertMutationAllowed();
    const isOuterTransaction = transactionDepth === 0;
    if (isOuterTransaction) {
      transactionStart = current;
    }

    transactionDepth += 1;
    try {
      return fn();
    } finally {
      transactionDepth -= 1;
      if (isOuterTransaction && !Object.is(transactionStart, current)) {
        pushPast(transactionStart);
        future = [];
        notify();
      }
    }
  };

  const historySnapshot = (): number =>
    (canUndo() ? 1 : 0) | (canRedo() ? 2 : 0);

  let api: UndoableStore<T>;

  const useStore = <Selected>(
    selector: (state: T) => Selected,
    isEqual: Equality<Selected> = Object.is,
  ): Selected => {
    const selectorRef = React.useRef(selector);
    const equalityRef = React.useRef(isEqual);
    const cacheRef = React.useRef<{
      state: T;
      selector: (state: T) => Selected;
      selection: Selected;
    } | null>(null);

    selectorRef.current = selector;
    equalityRef.current = isEqual;

    const getSelectedSnapshot = React.useCallback((): Selected => {
      const state = get();
      const currentSelector = selectorRef.current;
      const cached = cacheRef.current;

      if (
        cached !== null &&
        Object.is(cached.state, state) &&
        cached.selector === currentSelector
      ) {
        return cached.selection;
      }

      const selection = currentSelector(state);
      if (cached !== null && equalityRef.current(cached.selection, selection)) {
        cacheRef.current = {
          state,
          selector: currentSelector,
          selection: cached.selection,
        };
        return cached.selection;
      }

      cacheRef.current = { state, selector: currentSelector, selection };
      return selection;
    }, []);

    return React.useSyncExternalStore(
      api.subscribe,
      getSelectedSnapshot,
      getSelectedSnapshot,
    );
  };

  const useUndoRedo = (): UndoRedoControls => {
    const flags = React.useSyncExternalStore(
      api.subscribe,
      historySnapshot,
      historySnapshot,
    );

    return React.useMemo(
      () => ({
        undo: api.undo,
        redo: api.redo,
        canUndo: (flags & 1) !== 0,
        canRedo: (flags & 2) !== 0,
      }),
      [flags],
    );
  };

  api = {
    get,
    set,
    subscribe,
    undo,
    redo,
    canUndo,
    canRedo,
    transact,
    useStore,
    useUndoRedo,
  };

  return api;
}
