import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type * as React from "react";
import { useState } from "react";
import { createUndoableStore } from "../src/index.js";

describe("useUndoRedo", () => {
  it("re-renders only when a can-flag flips, not on every store change", () => {
    const store = createUndoableStore(0);
    let renders = 0;

    function Controls(): React.ReactElement {
      renders += 1;
      const { canUndo, canRedo } = store.useUndoRedo();
      return (
        <span data-testid="flags">{`${String(canUndo)}/${String(canRedo)}`}</span>
      );
    }

    render(<Controls />);
    expect(renders).toBe(1);
    expect(screen.getByTestId("flags").textContent).toBe("false/false");

    // First set flips canUndo false -> true: one re-render.
    act(() => {
      store.set(1);
    });
    expect(renders).toBe(2);
    expect(screen.getByTestId("flags").textContent).toBe("true/false");

    // Further sets change the value but no flag: no re-renders at all.
    act(() => {
      store.set(2);
    });
    act(() => {
      store.set(3);
    });
    act(() => {
      store.set(4);
    });
    expect(store.get()).toBe(4);
    expect(renders).toBe(2);

    // Undo flips canRedo false -> true: one re-render.
    act(() => {
      store.undo();
    });
    expect(renders).toBe(3);
    expect(screen.getByTestId("flags").textContent).toBe("true/true");

    // Another undo changes neither flag: no re-render.
    act(() => {
      store.undo();
    });
    expect(renders).toBe(3);
  });

  it("flips canUndo back to false at the start of the timeline", () => {
    const store = createUndoableStore(0);
    let renders = 0;

    function Controls(): React.ReactElement {
      renders += 1;
      const { canUndo } = store.useUndoRedo();
      return <span data-testid="can-undo">{String(canUndo)}</span>;
    }

    render(<Controls />);
    act(() => {
      store.set(1);
    });
    const rendersAfterFlip = renders;

    act(() => {
      store.undo();
    });

    expect(screen.getByTestId("can-undo").textContent).toBe("false");
    expect(renders).toBe(rendersAfterFlip + 1);
  });

  it("drives undo and redo from the returned callbacks", () => {
    const store = createUndoableStore("a");

    function Controls(): React.ReactElement {
      const { undo, redo, canUndo, canRedo } = store.useUndoRedo();
      const value = store.useStore((current: string) => current);
      return (
        <div>
          <span data-testid="value">{value}</span>
          <button type="button" onClick={undo} disabled={!canUndo}>
            undo
          </button>
          <button type="button" onClick={redo} disabled={!canRedo}>
            redo
          </button>
        </div>
      );
    }

    render(<Controls />);
    act(() => {
      store.set("b");
    });
    expect(screen.getByTestId("value").textContent).toBe("b");

    act(() => {
      screen.getByRole("button", { name: "undo" }).click();
    });
    expect(screen.getByTestId("value").textContent).toBe("a");

    act(() => {
      screen.getByRole("button", { name: "redo" }).click();
    });
    expect(screen.getByTestId("value").textContent).toBe("b");
  });

  it("keeps undo and redo callback identities stable across flag flips", () => {
    const store = createUndoableStore(0);
    const undos: Array<() => void> = [];
    const redos: Array<() => void> = [];

    function Controls(): React.ReactElement {
      const { undo, redo } = store.useUndoRedo();
      undos.push(undo);
      redos.push(redo);
      return <span />;
    }

    render(<Controls />);
    act(() => {
      store.set(1);
    });
    act(() => {
      store.undo();
    });

    expect(undos.length).toBeGreaterThan(1);
    for (const undo of undos) expect(undo).toBe(undos[0]);
    for (const redo of redos) expect(redo).toBe(redos[0]);
  });

  it("returns the same object when re-rendered without a flag flip", () => {
    const store = createUndoableStore(0);
    const results: ReturnType<typeof store.useUndoRedo>[] = [];
    let forceRerender = (): void => {};

    function Controls(): React.ReactElement {
      const [, setTick] = useState(0);
      forceRerender = () => setTick((tick) => tick + 1);
      results.push(store.useUndoRedo());
      return <span />;
    }

    render(<Controls />);
    expect(results).toHaveLength(1);

    // A re-render driven by unrelated local state must reuse the memoized
    // controls object, so consumers memoizing on it are not invalidated.
    act(() => {
      forceRerender();
    });
    expect(results).toHaveLength(2);
    expect(results[1]).toBe(results[0]);

    // A real flag flip must produce a new object.
    act(() => {
      store.set(1);
    });
    expect(results).toHaveLength(3);
    expect(results[2]).not.toBe(results[0]);
    expect(results[2]?.canUndo).toBe(true);
  });

  it("re-renders a value component but not the controls when only the value changes", () => {
    const store = createUndoableStore({ n: 0 });
    let controlRenders = 0;
    let valueRenders = 0;

    function Controls(): React.ReactElement {
      controlRenders += 1;
      const { canUndo } = store.useUndoRedo();
      return <span data-testid="can-undo">{String(canUndo)}</span>;
    }
    function Value(): React.ReactElement {
      valueRenders += 1;
      const n = store.useStore((current: { n: number }) => current.n);
      return <span data-testid="n">{n}</span>;
    }

    render(
      <>
        <Controls />
        <Value />
      </>,
    );

    act(() => {
      store.set({ n: 1 }); // flips canUndo
    });
    act(() => {
      store.set({ n: 2 }); // flag unchanged
    });
    act(() => {
      store.set({ n: 3 }); // flag unchanged
    });

    expect(screen.getByTestId("n").textContent).toBe("3");
    expect(valueRenders).toBe(4); // mount + three value changes
    expect(controlRenders).toBe(2); // mount + the single flag flip
  });

  it("re-renders once for a transaction that flips a flag", () => {
    const store = createUndoableStore(0);
    let renders = 0;

    function Controls(): React.ReactElement {
      renders += 1;
      const { canUndo } = store.useUndoRedo();
      return <span data-testid="can-undo">{String(canUndo)}</span>;
    }

    render(<Controls />);
    act(() => {
      store.transact(() => {
        store.set(1);
        store.set(2);
        store.set(3);
      });
    });

    expect(screen.getByTestId("can-undo").textContent).toBe("true");
    expect(renders).toBe(2);
  });

  it("unsubscribes on unmount", () => {
    const store = createUndoableStore(0);
    let renders = 0;

    function Controls(): React.ReactElement {
      renders += 1;
      const { canUndo } = store.useUndoRedo();
      return <span>{String(canUndo)}</span>;
    }

    const view = render(<Controls />);
    view.unmount();
    const rendersAfterUnmount = renders;

    act(() => {
      store.set(1); // would flip canUndo if still mounted
    });

    expect(renders).toBe(rendersAfterUnmount);
  });
});
