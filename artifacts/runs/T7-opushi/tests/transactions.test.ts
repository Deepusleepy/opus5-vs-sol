import { describe, expect, it, vi } from "vitest";
import { createUndoableStore } from "../src/index.js";

describe("transactions", () => {
  it("collapses many sets into one history entry and one notification", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.transact(() => {
      store.set(1);
      store.set(2);
      store.set(3);
    });

    expect(store.get()).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(3); // final value only

    store.undo();
    expect(store.get()).toBe(0); // one step back over the whole batch
    expect(store.canUndo()).toBe(false);
  });

  it("exposes intermediate values to reads inside the transaction", () => {
    const store = createUndoableStore(0);
    const seen: number[] = [];

    store.transact(() => {
      store.set(1);
      seen.push(store.get());
      store.set((previous) => previous + 1);
      seen.push(store.get());
    });

    expect(seen).toEqual([1, 2]);
  });

  it("joins a nested transaction to the outer one", () => {
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
    expect(store.get()).toBe(0); // the whole nest is one entry
    expect(store.canUndo()).toBe(false);
  });

  it("does not notify or record when a nested transaction closes", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.transact(() => {
      store.transact(() => {
        store.set(1);
      });
      // Inner transaction has closed; nothing should have fired yet.
      expect(listener).not.toHaveBeenCalled();
      expect(store.canUndo()).toBe(false);
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.canUndo()).toBe(true);
  });

  it("records nothing for an empty transaction", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.transact(() => {});

    expect(listener).not.toHaveBeenCalled();
    expect(store.canUndo()).toBe(false);
  });

  it("records nothing when a transaction nets out to the original value", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.transact(() => {
      store.set(1);
      store.set(2);
      store.set(0); // back where it started
    });

    expect(store.get()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(store.canUndo()).toBe(false);
  });

  it("rolls back and stays silent when the transaction body throws", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(() =>
      store.transact(() => {
        store.set(1);
        store.set(2);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(store.get()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(store.canUndo()).toBe(false);
  });

  it("rolls back the whole nest when an inner transaction throws", () => {
    const store = createUndoableStore(0);

    expect(() =>
      store.transact(() => {
        store.set(1);
        store.transact(() => {
          store.set(2);
          throw new Error("inner boom");
        });
      }),
    ).toThrow("inner boom");

    expect(store.get()).toBe(0);
    expect(store.canUndo()).toBe(false);
  });

  it("stays usable after a failed transaction", () => {
    const store = createUndoableStore(0);

    expect(() =>
      store.transact(() => {
        store.set(1);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // The transaction depth must have been reset, or this set would be swallowed.
    store.set(7);
    expect(store.get()).toBe(7);
    expect(store.canUndo()).toBe(true);
  });

  it("lets an inner transaction catch its own error without losing the outer one", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.transact(() => {
      store.set(1);
      try {
        store.transact(() => {
          store.set(2);
          throw new Error("handled");
        });
      } catch {
        // Swallowed: the outer transaction continues. Because the nested call
        // joins the outer one, its partial write to 2 is NOT rolled back.
      }
      store.set(3);
    });

    expect(store.get()).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects undo and redo while a transaction is open", () => {
    const store = createUndoableStore(0);
    store.set(1);

    expect(() =>
      store.transact(() => {
        store.undo();
      }),
    ).toThrow(/cannot be called inside transact/);

    expect(() =>
      store.transact(() => {
        store.redo();
      }),
    ).toThrow(/cannot be called inside transact/);
  });
});
