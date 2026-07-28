import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUndoableStore } from "../src/index";

afterEach(cleanup);

describe("external store and history", () => {
  it("supports undo, redo, branch invalidation, and no-op updates", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(1);
    store.set((value) => value + 1);
    expect(store.get()).toBe(2);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);

    store.undo();
    expect(store.get()).toBe(1);
    expect(store.canRedo()).toBe(true);
    store.redo();
    expect(store.get()).toBe(2);

    store.undo();
    store.set(7);
    expect(store.get()).toBe(7);
    expect(store.canRedo()).toBe(false);

    const calls = listener.mock.calls.length;
    store.set(7);
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("caps undo history at 100 entries", () => {
    const store = createUndoableStore(0);
    for (let value = 1; value <= 101; value += 1) store.set(value);
    for (let count = 0; count < 100; count += 1) store.undo();

    expect(store.get()).toBe(1);
    expect(store.canUndo()).toBe(false);
  });

  it("handles undefined as a valid historical state", () => {
    const store = createUndoableStore<number | undefined>(undefined);
    store.set(1);
    store.undo();
    expect(store.get()).toBeUndefined();
    expect(store.canRedo()).toBe(true);
  });

  it("notifies external subscribers in insertion order with committed state", () => {
    const store = createUndoableStore(0);
    const events: string[] = [];
    const unsubscribeFirst = store.subscribe(() => events.push(`first:${store.get()}`));
    store.subscribe(() => events.push(`second:${store.get()}`));

    store.set(1);
    unsubscribeFirst();
    store.set(2);

    expect(events).toEqual(["first:1", "second:1", "second:2"]);
  });

  it("batches nested transactions into one history entry and notification", () => {
    const store = createUndoableStore({ count: 0, label: "a" });
    const listener = vi.fn();
    store.subscribe(listener);

    const result = store.transact(() => {
      store.set((state) => ({ ...state, count: 1 }));
      store.transact(() => {
        store.set((state) => ({ ...state, count: 2 }));
        store.set((state) => ({ ...state, label: "b" }));
      });
      return "result";
    });

    expect(result).toBe("result");
    expect(store.get()).toEqual({ count: 2, label: "b" });
    expect(listener).toHaveBeenCalledTimes(1);
    store.undo();
    expect(store.get()).toEqual({ count: 0, label: "a" });
    expect(store.canUndo()).toBe(false);
  });
});

describe("React hooks", () => {
  it("only re-renders when the selected slice changes", () => {
    const store = createUndoableStore({ count: 0, label: "a" });
    let renders = 0;

    function Counter() {
      renders += 1;
      const count = store.useStore((state) => state.count);
      return <span>{count}</span>;
    }

    const view = render(<Counter />);
    expect(renders).toBe(1);
    act(() => store.set((state) => ({ ...state, label: "b" })));
    expect(renders).toBe(1);
    act(() => store.set((state) => ({ ...state, count: 1 })));
    expect(renders).toBe(2);
    expect(view.getByText("1")).toBeTruthy();
  });

  it("does not resubscribe when selector identity changes", () => {
    const store = createUndoableStore({ value: 2 });
    let subscriptions = 0;
    const originalSubscribe = store.subscribe;
    store.subscribe = (listener) => {
      subscriptions += 1;
      return originalSubscribe(listener);
    };

    function Value({ multiplier }: { multiplier: number }) {
      const value = store.useStore((state) => state.value * multiplier);
      return <span>{value}</span>;
    }

    const view = render(<Value multiplier={1} />);
    const subscriptionsAfterMount = subscriptions;
    expect(subscriptionsAfterMount).toBe(1);
    view.rerender(<Value multiplier={3} />);

    expect(view.getByText("6")).toBeTruthy();
    expect(subscriptions).toBe(subscriptionsAfterMount);
  });

  it("honors a custom equality function", () => {
    const store = createUndoableStore({ count: 0, ignored: 0 });
    let renders = 0;

    function CountObject() {
      renders += 1;
      const selected = store.useStore(
        (state) => ({ count: state.count }),
        (left, right) => left.count === right.count,
      );
      return <span>{selected.count}</span>;
    }

    render(<CountObject />);
    act(() => store.set((state) => ({ ...state, ignored: 1 })));
    expect(renders).toBe(1);
  });

  it("useUndoRedo re-renders only when availability flags flip", () => {
    const store = createUndoableStore(0);
    let renders = 0;

    function Controls() {
      renders += 1;
      const { canUndo, canRedo } = store.useUndoRedo();
      return <span>{`${canUndo}:${canRedo}`}</span>;
    }

    const view = render(<Controls />);
    expect(renders).toBe(1);
    act(() => store.set(1));
    expect(renders).toBe(2);
    act(() => store.set(2));
    expect(renders).toBe(2);
    act(() => store.undo());
    expect(renders).toBe(3);
    act(() => store.undo());
    expect(renders).toBe(4);
    expect(view.getByText("false:true")).toBeTruthy();
  });

  it("throws a descriptive error for a render-phase mutation", () => {
    const store = createUndoableStore(0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    function BadComponent() {
      store.set(1);
      return null;
    }

    expect(() => render(<BadComponent />)).toThrow(/cannot be called while a React component is rendering/i);
    expect(store.get()).toBe(0);
    errorSpy.mockRestore();
  });
});
