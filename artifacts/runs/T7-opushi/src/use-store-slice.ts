import * as React from "react";

/** The minimum a `useStoreSlice` source must provide. */
export interface ReadableStore<T> {
  get(): T;
  subscribe(listener: (value: T) => void): () => void;
}

/**
 * Subscribe a component to a slice of an external store.
 *
 * Re-renders only when the selected slice changes — by `Object.is`, or by
 * `isEqual` when supplied. `store.subscribe` is passed to
 * `useSyncExternalStore` untouched, so a store with a stable `subscribe`
 * identity is never resubscribed, however often `selector` changes identity.
 *
 * Tearing safety: `useSyncExternalStore` is the only supported way to read
 * mutable external state under concurrent React. React reads the snapshot at
 * the start of the render pass and, before committing, re-reads it and
 * re-renders synchronously if it moved. A time-sliced render that was
 * interrupted by a store write therefore cannot commit a mix of old and new
 * values, which is what reading the store in `useEffect` + `useState` would
 * allow.
 */
export function useStoreSlice<T, S>(
  store: ReadableStore<T>,
  selector: (value: T) => S,
  isEqual?: (a: S, b: S) => boolean,
): S {
  // `useSyncExternalStore` requires `getSnapshot` to return an identical result
  // until the store really changes; a selector that builds a fresh object would
  // otherwise loop forever. Caching keyed on the store value provides that, and
  // `isEqual` additionally preserves the previous selection so React's own
  // Object.is check bails out of the re-render.
  const getSelection = React.useMemo(() => {
    let cached = false;
    let cachedValue: T;
    let cachedSelection: S;
    return (): S => {
      const current = store.get();
      if (cached && Object.is(cachedValue, current)) return cachedSelection;
      const next = selector(current);
      const unchanged =
        cached && isEqual !== undefined && isEqual(cachedSelection, next);
      cached = true;
      cachedValue = current;
      if (!unchanged) cachedSelection = next;
      return cachedSelection;
    };
  }, [store, selector, isEqual]);

  // The third argument (server snapshot) is the same function: this store holds
  // ordinary client state, with no distinct server value.
  return React.useSyncExternalStore(
    store.subscribe,
    getSelection,
    getSelection,
  );
}
