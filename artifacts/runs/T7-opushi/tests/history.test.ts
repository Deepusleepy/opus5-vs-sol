import { describe, expect, it, vi } from "vitest";
import { createUndoableStore, HISTORY_LIMIT } from "../src/index.js";

describe("history semantics", () => {
  it("undoes and redoes back through a chain of values", () => {
    const store = createUndoableStore(0);
    store.set(1);
    store.set(2);
    store.set(3);

    expect(store.get()).toBe(3);
    store.undo();
    expect(store.get()).toBe(2);
    store.undo();
    expect(store.get()).toBe(1);
    store.redo();
    expect(store.get()).toBe(2);
    store.redo();
    expect(store.get()).toBe(3);
  });

  it("reports canUndo/canRedo at the ends of the timeline", () => {
    const store = createUndoableStore("a");
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);

    store.set("b");
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);

    store.undo();
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);
  });

  it("ignores undo at the start and redo at the end without notifying", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.undo();
    store.redo();

    expect(store.get()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("accepts an updater function that receives the previous value", () => {
    const store = createUndoableStore(10);
    store.set((previous) => previous + 5);
    expect(store.get()).toBe(15);
    store.undo();
    expect(store.get()).toBe(10);
  });

  it("treats a set to an identical value as a no-op", () => {
    const store = createUndoableStore({ n: 1 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set((previous) => previous); // same reference

    expect(listener).not.toHaveBeenCalled();
    expect(store.canUndo()).toBe(false);
  });

  it("records a new entry when a set produces an equal but distinct object", () => {
    // History is identity-based (Object.is), not deep-equality based.
    const store = createUndoableStore({ n: 1 });
    store.set({ n: 1 });
    expect(store.canUndo()).toBe(true);
  });

  describe("redo-branch invalidation", () => {
    it("clears the redo stack when a new set follows an undo", () => {
      const store = createUndoableStore(0);
      store.set(1);
      store.set(2);
      store.undo();
      expect(store.get()).toBe(1);
      expect(store.canRedo()).toBe(true);

      store.set(99); // branches off the timeline

      expect(store.canRedo()).toBe(false);
      store.redo();
      expect(store.get()).toBe(99);

      // The old branch is gone; undo now leads back through the new one.
      store.undo();
      expect(store.get()).toBe(1);
    });

    it("clears the redo stack when a transaction follows an undo", () => {
      const store = createUndoableStore(0);
      store.set(1);
      store.undo();
      expect(store.canRedo()).toBe(true);

      store.transact(() => {
        store.set(42);
      });

      expect(store.canRedo()).toBe(false);
      expect(store.get()).toBe(42);
    });

    it("does not clear the redo stack for a no-op set", () => {
      const store = createUndoableStore(0);
      store.set(1);
      store.undo();

      store.set(0); // equal to the current value, so nothing happens

      expect(store.canRedo()).toBe(true);
      store.redo();
      expect(store.get()).toBe(1);
    });
  });

  describe("history cap", () => {
    it(`retains exactly ${HISTORY_LIMIT} undo steps and drops the oldest`, () => {
      const store = createUndoableStore(0);
      for (let i = 1; i <= HISTORY_LIMIT + 50; i += 1) store.set(i);

      let steps = 0;
      while (store.canUndo()) {
        store.undo();
        steps += 1;
        expect(steps).toBeLessThanOrEqual(HISTORY_LIMIT + 1); // guard runaway
      }

      expect(steps).toBe(HISTORY_LIMIT);
      // Oldest surviving state, not the original 0.
      expect(store.get()).toBe(HISTORY_LIMIT + 50 - HISTORY_LIMIT);
      expect(store.get()).toBe(50);
    });

    it("keeps the full range reachable when under the cap", () => {
      const store = createUndoableStore(0);
      for (let i = 1; i <= HISTORY_LIMIT; i += 1) store.set(i);

      let steps = 0;
      while (store.canUndo()) {
        store.undo();
        steps += 1;
      }

      expect(steps).toBe(HISTORY_LIMIT);
      expect(store.get()).toBe(0); // the original value is still reachable
    });

    it("counts a transaction as a single entry against the cap", () => {
      const store = createUndoableStore(0);
      store.transact(() => {
        for (let i = 1; i <= HISTORY_LIMIT + 50; i += 1) store.set(i);
      });

      store.undo();
      expect(store.get()).toBe(0);
      expect(store.canUndo()).toBe(false);
    });
  });

  it("supports a store whose value type includes undefined", () => {
    const store = createUndoableStore<number | undefined>(undefined);
    store.set(1);
    store.set(undefined);
    expect(store.get()).toBeUndefined();
    store.undo();
    expect(store.get()).toBe(1);
    store.undo();
    expect(store.get()).toBeUndefined();
    expect(store.canUndo()).toBe(false);
  });
});
