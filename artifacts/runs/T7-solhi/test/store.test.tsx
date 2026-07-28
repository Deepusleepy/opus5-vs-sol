import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUndoableStore } from "../src/index.js";

afterEach(cleanup);

describe("createUndoableStore", () => {
  it("supports undo, redo, and invalidates the redo branch after a new set", () => {
    const store = createUndoableStore(0);

    store.set((value) => value + 1);
    store.set((value) => value + 1);
    expect(store.get()).toBe(2);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);

    store.undo();
    expect(store.get()).toBe(1);
    expect(store.canRedo()).toBe(true);

    store.set(() => 10);
    expect(store.get()).toBe(10);
    expect(store.canRedo()).toBe(false);

    store.redo();
    expect(store.get()).toBe(10);
  });

  it("caps undo history at 100 entries", () => {
    const store = createUndoableStore(0);

    for (let index = 0; index < 105; index += 1) {
      store.set((value) => value + 1);
    }
    for (let index = 0; index < 100; index += 1) {
      store.undo();
    }

    expect(store.get()).toBe(5);
    expect(store.canUndo()).toBe(false);
    store.undo();
    expect(store.get()).toBe(5);
  });

  it("commits nested transactions as one history entry and one notification", () => {
    const store = createUndoableStore({ count: 0, label: "start" });
    const snapshots: Array<{ count: number; label: string }> = [];
    store.subscribe(() => snapshots.push(store.get()));

    const result = store.transact(() => {
      store.set((state) => ({ ...state, count: 1 }));
      expect(store.get().count).toBe(1);
      store.transact(() => {
        store.set((state) => ({ ...state, count: 2 }));
        store.set((state) => ({ ...state, label: "done" }));
      });
      return "result";
    });

    expect(result).toBe("result");
    expect(store.get()).toEqual({ count: 2, label: "done" });
    expect(snapshots).toEqual([{ count: 2, label: "done" }]);

    store.undo();
    expect(store.get()).toEqual({ count: 0, label: "start" });
    expect(store.canUndo()).toBe(false);
  });

  it("does not record or notify a transaction with no net state change", () => {
    const initial = { count: 0 };
    const store = createUndoableStore(initial);
    const subscriber = vi.fn();
    store.subscribe(subscriber);

    store.transact(() => {
      store.set(() => ({ count: 1 }));
      store.set(() => initial);
    });

    expect(subscriber).not.toHaveBeenCalled();
    expect(store.canUndo()).toBe(false);
  });

  it("notifies external subscribers in subscription order after updating state", () => {
    const store = createUndoableStore(0);
    const events: string[] = [];
    const unsubscribeFirst = store.subscribe(() => events.push(`first:${store.get()}`));
    store.subscribe(() => events.push(`second:${store.get()}`));

    store.set(() => 1);
    unsubscribeFirst();
    store.set(() => 2);

    expect(events).toEqual(["first:1", "second:1", "second:2"]);
  });

  it("re-renders only when the selected slice changes", () => {
    const store = createUndoableStore({ left: 0, right: 0 });
    let renders = 0;

    function LeftValue() {
      renders += 1;
      const left = store.useStore((state) => state.left);
      return <span>{left}</span>;
    }

    render(<LeftValue />);
    expect(renders).toBe(1);

    act(() => store.set((state) => ({ ...state, right: 1 })));
    expect(renders).toBe(1);

    act(() => store.set((state) => ({ ...state, left: 1 })));
    expect(renders).toBe(2);
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("uses a custom equality function for selected values", () => {
    const store = createUndoableStore({ item: { id: 1, label: "one" }, other: 0 });
    let renders = 0;

    function Item() {
      renders += 1;
      const item = store.useStore(
        (state) => state.item,
        (previous, next) => previous.id === next.id,
      );
      return <span>{item.label}</span>;
    }

    render(<Item />);
    act(() => {
      store.set((state) => ({ ...state, item: { id: 1, label: "changed" } }));
    });

    expect(renders).toBe(1);
    expect(screen.getByText("one")).toBeTruthy();
  });

  it("does not resubscribe when selector identity changes", () => {
    const store = createUndoableStore({ first: "A", second: "B" });
    const subscribe = vi.spyOn(store, "subscribe");

    function Value({ field }: { field: "first" | "second" }) {
      const value = store.useStore((state) => state[field]);
      return <span>{value}</span>;
    }

    const view = render(<Value field="first" />);
    expect(screen.getByText("A")).toBeTruthy();
    view.rerender(<Value field="second" />);

    expect(screen.getByText("B")).toBeTruthy();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("re-renders useUndoRedo only when its capability flags change", () => {
    const store = createUndoableStore(0);
    let renders = 0;

    function Controls() {
      renders += 1;
      const { canUndo, canRedo } = store.useUndoRedo();
      return <span>{`${canUndo}/${canRedo}`}</span>;
    }

    render(<Controls />);
    expect(renders).toBe(1);

    act(() => store.set((value) => value + 1));
    expect(renders).toBe(2);
    expect(screen.getByText("true/false")).toBeTruthy();

    act(() => store.set((value) => value + 1));
    expect(renders).toBe(2);

    act(() => store.undo());
    expect(renders).toBe(3);
    expect(screen.getByText("true/true")).toBeTruthy();

    act(() => store.undo());
    expect(renders).toBe(4);
    expect(screen.getByText("false/true")).toBeTruthy();
  });

  it("throws a descriptive error when set is called during React render", async () => {
    const store = createUndoableStore(0);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    function InvalidRender() {
      store.set((value) => value + 1);
      return null;
    }

    expect(() => render(<InvalidRender />)).toThrow(/cannot be changed during React render/i);
    expect(store.get()).toBe(0);

    await Promise.resolve();
    store.set((value) => value + 1);
    expect(store.get()).toBe(1);
  });
});
