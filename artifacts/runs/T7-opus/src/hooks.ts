import { useCallback, useRef, useSyncExternalStore } from "react";
import type { UndoableStore } from "./store.js";

export type Selector<T, S> = (state: T) => S;
export type IsEqual<S> = (a: S, b: S) => boolean;

export interface UndoRedo {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export interface StoreHooks<T> {
  /**
   * Subscribe to a slice of the store. The component re-renders only when
   * `isEqual(previousSlice, nextSlice)` is false (default: `Object.is`).
   * Changing the selector's identity between renders re-reads the slice but
   * never re-subscribes.
   */
  useStore<S>(selector: Selector<T, S>, isEqual?: IsEqual<S>): S;
  /** `{undo, redo, canUndo, canRedo}`; re-renders only when a can-flag flips. */
  useUndoRedo(): UndoRedo;
}

/** A cached slice; `has` distinguishes "never computed" from "computed undefined". */
interface Cache<S> {
  has: boolean;
  value: S;
}

export function createStoreHooks<T>(store: UndoableStore<T>): StoreHooks<T> {
  // `store.subscribe` is a stable function for the lifetime of the store, so
  // useSyncExternalStore's subscription effect never re-runs.
  const subscribe = store.subscribe;

  function useStore<S>(selector: Selector<T, S>, isEqual?: IsEqual<S>): S {
    // Refs, not deps: the latest selector/comparator is used on every read,
    // but neither participates in the subscription.
    const selectorRef = useRef(selector);
    const isEqualRef = useRef(isEqual);
    selectorRef.current = selector;
    isEqualRef.current = isEqual;

    const cacheRef = useRef<Cache<S>>({ has: false, value: undefined as S });

    // Stable across renders, so React never treats a new selector identity as
    // a reason to resubscribe. Returning the cached slice when the comparator
    // says it is unchanged is what suppresses the re-render.
    const getSnapshot = useCallback((): S => {
      const next = selectorRef.current(store.get());
      const cache = cacheRef.current;
      const equal = isEqualRef.current ?? Object.is;
      if (cache.has && equal(cache.value, next)) return cache.value;
      cache.has = true;
      cache.value = next;
      return next;
    }, []);

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  function useUndoRedo(): UndoRedo {
    const cacheRef = useRef<Cache<UndoRedo>>({ has: false, value: undefined as unknown as UndoRedo });

    const getSnapshot = useCallback((): UndoRedo => {
      const canUndo = store.canUndo();
      const canRedo = store.canRedo();
      const cache = cacheRef.current;
      if (cache.has && cache.value.canUndo === canUndo && cache.value.canRedo === canRedo) {
        return cache.value;
      }
      cache.has = true;
      // `store.undo` / `store.redo` are stable, so the object only changes
      // identity when a flag actually flips.
      cache.value = { undo: store.undo, redo: store.redo, canUndo, canRedo };
      return cache.value;
    }, []);

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  return { useStore, useUndoRedo };
}
