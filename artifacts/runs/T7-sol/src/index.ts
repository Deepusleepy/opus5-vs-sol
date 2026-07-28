import React from "react";

export type Updater<T> = T | ((current: T) => T);
export type EqualityFn<S> = (left: S, right: S) => boolean;

type Listener = () => void;
type Selector<T, S> = (state: T) => S;

type Dispatcher = {
  useState?: { name?: string };
};

type ReactInternals = {
  H?: Dispatcher | null;
  ReactCurrentDispatcher?: { current?: Dispatcher | null };
};

function isRenderingReactComponent(): boolean {
  const react = React as typeof React & {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: ReactInternals;
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?: ReactInternals;
  };
  const internals =
    react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ??
    react.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const dispatcher = internals?.H ?? internals?.ReactCurrentDispatcher?.current;
  return dispatcher != null && dispatcher.useState?.name !== "throwInvalidHookError";
}

export interface UndoableStore<T> {
  get(): T;
  set(updater: Updater<T>): void;
  subscribe(listener: Listener): () => void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  transact<R>(fn: () => R): R;
  useStore<S>(selector: Selector<T, S>, isEqual?: EqualityFn<S>): S;
  useUndoRedo(): {
    undo: () => void;
    redo: () => void;
    canUndo: boolean;
    canRedo: boolean;
  };
}

const HISTORY_LIMIT = 100;

export function createUndoableStore<T>(initial: T): UndoableStore<T> {
  let state = initial;
  let undoStack: T[] = [];
  let redoStack: T[] = [];
  let transactionDepth = 0;
  let transactionStart = initial;
  let renderMutationBlocked = false;
  let api: UndoableStore<T>;
  const listeners = new Set<Listener>();

  const notify = (): void => {
    [...listeners].forEach((listener) => listener());
  };

  const pushUndo = (value: T): void => {
    undoStack.push(value);
    if (undoStack.length > HISTORY_LIMIT) {
      undoStack = undoStack.slice(-HISTORY_LIMIT);
    }
  };

  const commit = (previous: T): void => {
    if (Object.is(previous, state)) return;
    pushUndo(previous);
    redoStack = [];
    notify();
  };

  const get = (): T => state;

  const set = (updater: Updater<T>): void => {
    if (isRenderingReactComponent()) {
      if (!renderMutationBlocked) {
        renderMutationBlocked = true;
        queueMicrotask(() => {
          renderMutationBlocked = false;
        });
      }
    }
    if (renderMutationBlocked) {
      throw new Error(
        "Store.set() cannot be called while a React component is rendering; move the update to an event handler or effect.",
      );
    }

    const previous = state;
    state = typeof updater === "function" ? (updater as (current: T) => T)(state) : updater;
    if (transactionDepth === 0) commit(previous);
  };

  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const undo = (): void => {
    if (transactionDepth > 0) throw new Error("undo() cannot be called inside a transaction.");
    if (undoStack.length === 0) return;
    const previous = undoStack.pop() as T;
    redoStack.push(state);
    state = previous;
    notify();
  };

  const redo = (): void => {
    if (transactionDepth > 0) throw new Error("redo() cannot be called inside a transaction.");
    if (redoStack.length === 0) return;
    const next = redoStack.pop() as T;
    pushUndo(state);
    state = next;
    notify();
  };

  const canUndo = (): boolean => undoStack.length > 0;
  const canRedo = (): boolean => redoStack.length > 0;

  const transact = <R>(fn: () => R): R => {
    if (transactionDepth === 0) transactionStart = state;
    transactionDepth += 1;
    try {
      return fn();
    } finally {
      transactionDepth -= 1;
      if (transactionDepth === 0) commit(transactionStart);
    }
  };

  const useStore = <S>(selector: Selector<T, S>, isEqual: EqualityFn<S> = Object.is): S => {
    const selectorRef = React.useRef(selector);
    const equalityRef = React.useRef(isEqual);
    const cacheRef = React.useRef<{
      state: T;
      selector: Selector<T, S>;
      equality: EqualityFn<S>;
      selection: S;
    } | null>(null);

    selectorRef.current = selector;
    equalityRef.current = isEqual;

    const getSelectedSnapshot = React.useCallback((): S => {
      const currentState = get();
      const currentSelector = selectorRef.current;
      const currentEquality = equalityRef.current;
      const cached = cacheRef.current;

      if (
        cached !== null &&
        Object.is(cached.state, currentState) &&
        cached.selector === currentSelector &&
        cached.equality === currentEquality
      ) {
        return cached.selection;
      }

      const nextSelection = currentSelector(currentState);
      const selection =
        cached !== null && currentEquality(cached.selection, nextSelection)
          ? cached.selection
          : nextSelection;
      cacheRef.current = {
        state: currentState,
        selector: currentSelector,
        equality: currentEquality,
        selection,
      };
      return selection;
    }, []);

    return React.useSyncExternalStore(api.subscribe, getSelectedSnapshot, getSelectedSnapshot);
  };

  const historySnapshot = (): number => (canUndo() ? 1 : 0) | (canRedo() ? 2 : 0);

  const useUndoRedo = () => {
    const flags = React.useSyncExternalStore(api.subscribe, historySnapshot, historySnapshot);
    return {
      undo,
      redo,
      canUndo: (flags & 1) !== 0,
      canRedo: (flags & 2) !== 0,
    };
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
