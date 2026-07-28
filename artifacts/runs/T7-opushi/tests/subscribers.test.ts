import { describe, expect, it, vi } from "vitest";
import { createUndoableStore } from "../src/index.js";

describe("external (non-React) subscribers", () => {
  it("works with no React involved at all", () => {
    const store = createUndoableStore({ count: 0 });
    const seen: number[] = [];
    store.subscribe((value) => seen.push(value.count));

    store.set({ count: 1 });
    store.set({ count: 2 });
    store.undo();

    expect(seen).toEqual([1, 2, 1]);
  });

  it("notifies listeners in subscription order", () => {
    const store = createUndoableStore(0);
    const order: string[] = [];
    store.subscribe(() => order.push("first"));
    store.subscribe(() => order.push("second"));
    store.subscribe(() => order.push("third"));

    store.set(1);

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("keeps the same order across repeated notifications", () => {
    const store = createUndoableStore(0);
    const order: string[] = [];
    store.subscribe(() => order.push("a"));
    store.subscribe(() => order.push("b"));

    store.set(1);
    store.set(2);
    store.undo();

    expect(order).toEqual(["a", "b", "a", "b", "a", "b"]);
  });

  it("passes the current value to every listener", () => {
    const store = createUndoableStore("start");
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);

    store.set("next");

    expect(a).toHaveBeenCalledWith("next");
    expect(b).toHaveBeenCalledWith("next");
  });

  it("sees the committed value via get() from inside a listener", () => {
    const store = createUndoableStore(0);
    let observed: number | null = null;
    store.subscribe(() => {
      observed = store.get();
    });

    store.set(5);

    expect(observed).toBe(5);
  });

  it("reports up-to-date history flags from inside a listener", () => {
    const store = createUndoableStore(0);
    const flags: Array<[boolean, boolean]> = [];
    store.subscribe(() => flags.push([store.canUndo(), store.canRedo()]));

    store.set(1); // now undoable
    store.undo(); // now redoable

    expect(flags).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("stops calling a listener after unsubscribe", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(1);
    unsubscribe();
    store.set(2);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("treats a repeated unsubscribe as a no-op", () => {
    const store = createUndoableStore(0);
    const kept = vi.fn();
    const dropped = vi.fn();
    const unsubscribe = store.subscribe(dropped);
    store.subscribe(kept);

    unsubscribe();
    unsubscribe(); // must not remove anyone else

    store.set(1);

    expect(dropped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it("does not call a listener added during an in-flight notification", () => {
    const store = createUndoableStore(0);
    const late = vi.fn();
    store.subscribe(() => {
      store.subscribe(late);
    });

    store.set(1);
    expect(late).not.toHaveBeenCalled(); // not for the notification it joined during

    store.set(2);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("still calls remaining listeners when one unsubscribes another mid-pass", () => {
    const store = createUndoableStore(0);
    const order: string[] = [];
    let unsubscribeSecond = (): void => {};

    store.subscribe(() => {
      order.push("first");
      unsubscribeSecond();
    });
    unsubscribeSecond = store.subscribe(() => order.push("second"));
    store.subscribe(() => order.push("third"));

    store.set(1);
    // "second" was already scheduled in this pass; the copy makes that safe.
    expect(order).toEqual(["first", "second", "third"]);

    order.length = 0;
    store.set(2);
    expect(order).toEqual(["first", "third"]);
  });

  it("interleaves external listeners with a transaction as one notification", () => {
    const store = createUndoableStore(0);
    const seen: number[] = [];
    store.subscribe((value) => seen.push(value));

    store.transact(() => {
      store.set(1);
      store.set(2);
    });

    expect(seen).toEqual([2]);
  });
});
