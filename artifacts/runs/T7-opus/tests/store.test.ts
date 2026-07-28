import { describe, expect, it, vi } from "vitest";
import { MAX_HISTORY, createUndoableStore } from "../src/index.js";

describe("basic store", () => {
  it("gets and sets", () => {
    const store = createUndoableStore({ count: 0 });
    expect(store.get()).toEqual({ count: 0 });
    store.set({ count: 1 });
    expect(store.get()).toEqual({ count: 1 });
    store.set((prev) => ({ count: prev.count + 1 }));
    expect(store.get()).toEqual({ count: 2 });
  });

  it("ignores sets that produce the identical value", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(0);
    store.set((n) => n);
    expect(listener).not.toHaveBeenCalled();
    expect(store.canUndo()).toBe(false);
  });

  it("unsubscribes", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set(1);
    off();
    store.set(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("history", () => {
  it("undoes and redoes", () => {
    const store = createUndoableStore(0);
    store.set(1);
    store.set(2);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);

    store.undo();
    expect(store.get()).toBe(1);
    expect(store.canRedo()).toBe(true);
    store.undo();
    expect(store.get()).toBe(0);
    expect(store.canUndo()).toBe(false);

    store.redo();
    expect(store.get()).toBe(1);
    store.redo();
    expect(store.get()).toBe(2);
    expect(store.canRedo()).toBe(false);
  });

  it("is a no-op at the ends of history", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);
    store.undo();
    store.redo();
    expect(store.get()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("invalidates the redo branch on a new set after undo", () => {
    const store = createUndoableStore(0);
    store.set(1);
    store.set(2);
    store.undo();
    expect(store.canRedo()).toBe(true);

    store.set(99);
    expect(store.canRedo()).toBe(false);
    store.redo();
    expect(store.get()).toBe(99);

    store.undo();
    expect(store.get()).toBe(1);
  });

  it("invalidates the redo branch on a transaction after undo", () => {
    const store = createUndoableStore(0);
    store.set(1);
    store.undo();
    expect(store.canRedo()).toBe(true);
    store.transact(() => {
      store.set(5);
    });
    expect(store.canRedo()).toBe(false);
  });

  it(`caps history at ${MAX_HISTORY} entries, dropping the oldest`, () => {
    const store = createUndoableStore(0);
    for (let i = 1; i <= MAX_HISTORY + 50; i += 1) store.set(i);
    expect(store.get()).toBe(MAX_HISTORY + 50);

    let undos = 0;
    while (store.canUndo()) {
      store.undo();
      undos += 1;
      expect(undos).toBeLessThanOrEqual(MAX_HISTORY + 1);
    }
    expect(undos).toBe(MAX_HISTORY);
    // 150 sets, 100 remembered: the oldest reachable value is 50.
    expect(store.get()).toBe(50);

    let redos = 0;
    while (store.canRedo()) {
      store.redo();
      redos += 1;
    }
    expect(redos).toBe(MAX_HISTORY);
    expect(store.get()).toBe(MAX_HISTORY + 50);
  });

  it("keeps the cap while redoing back and forth", () => {
    const store = createUndoableStore(0);
    for (let i = 1; i <= MAX_HISTORY + 10; i += 1) store.set(i);
    for (let i = 0; i < 20; i += 1) store.undo();
    for (let i = 0; i < 20; i += 1) store.redo();
    let undos = 0;
    while (store.canUndo()) {
      store.undo();
      undos += 1;
      if (undos > MAX_HISTORY) break;
    }
    expect(undos).toBe(MAX_HISTORY);
  });
});

describe("transactions", () => {
  it("collapses many sets into one history entry and one notification", () => {
    const store = createUndoableStore({ a: 0, b: 0 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.transact(() => {
      store.set((s) => ({ ...s, a: 1 }));
      store.set((s) => ({ ...s, b: 2 }));
      store.set((s) => ({ ...s, a: 3 }));
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ a: 3, b: 2 });
    store.undo();
    expect(store.get()).toEqual({ a: 0, b: 0 });
    expect(store.canUndo()).toBe(false);
  });

  it("joins nested transactions into the outer one", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.transact(() => {
      store.set(1);
      store.transact(() => {
        store.set(2);
        store.transact(() => {
          store.set(3);
        });
        store.set(4);
      });
      store.set(5);
    });

    expect(store.get()).toBe(5);
    expect(listener).toHaveBeenCalledTimes(1);
    store.undo();
    expect(store.get()).toBe(0);
    expect(store.canUndo()).toBe(false);
  });

  it("reads the in-progress value inside a transaction", () => {
    const store = createUndoableStore(0);
    const seen: number[] = [];
    store.transact(() => {
      store.set(1);
      seen.push(store.get());
      store.set((n) => n + 1);
      seen.push(store.get());
    });
    expect(seen).toEqual([1, 2]);
  });

  it("records nothing when a transaction makes no net change", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);
    store.transact(() => {
      /* no sets */
    });
    expect(listener).not.toHaveBeenCalled();
    expect(store.canUndo()).toBe(false);
  });

  it("rolls back and rethrows when the transaction body throws", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() =>
      store.transact(() => {
        store.set(1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.get()).toBe(0);
    expect(store.canUndo()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    // Not left in a transaction.
    store.set(7);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects undo/redo inside a transaction", () => {
    const store = createUndoableStore(0);
    store.set(1);
    expect(() =>
      store.transact(() => {
        store.undo();
      }),
    ).toThrow(/cannot be called inside transact/);
  });
});

describe("external subscriber ordering", () => {
  it("notifies listeners in registration order, once per commit", () => {
    const store = createUndoableStore(0);
    const calls: string[] = [];
    store.subscribe(() => calls.push(`a:${store.get()}`));
    store.subscribe(() => calls.push(`b:${store.get()}`));
    store.subscribe(() => calls.push(`c:${store.get()}`));

    store.set(1);
    store.transact(() => {
      store.set(2);
      store.set(3);
    });
    store.undo();
    store.redo();

    expect(calls).toEqual([
      "a:1", "b:1", "c:1",
      "a:3", "b:3", "c:3",
      "a:1", "b:1", "c:1",
      "a:3", "b:3", "c:3",
    ]);
  });

  it("survives a listener unsubscribing during notification", () => {
    const store = createUndoableStore(0);
    const calls: string[] = [];
    const offB = store.subscribe(() => {
      calls.push("b");
      offB();
    });
    store.subscribe(() => calls.push("c"));

    store.set(1);
    store.set(2);
    expect(calls).toEqual(["b", "c", "c"]);
  });
});
