import { act, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { createStoreHooks, createUndoableStore } from "../src/index.js";

describe("StrictMode", () => {
  it("stays correct under double-invoked renders and remounted effects", () => {
    const store = createUndoableStore({ a: 0 });
    const { useStore } = createStoreHooks(store);

    function ShowA(): React.ReactElement {
      return <span data-testid="a">{useStore((s) => s.a)}</span>;
    }

    render(
      <React.StrictMode>
        <ShowA />
      </React.StrictMode>,
    );
    expect(screen.getByTestId("a").textContent).toBe("0");

    act(() => {
      store.set({ a: 1 });
    });
    expect(screen.getByTestId("a").textContent).toBe("1");

    act(() => {
      store.undo();
    });
    expect(screen.getByTestId("a").textContent).toBe("0");
  });
});

describe("concurrent features", () => {
  it("shows one consistent value across siblings when a transition is interrupted", () => {
    // Two components read the same slice through different selectors. If the
    // subscription were not tearing-safe, an update landing mid-render could
    // leave one sibling on the old value and the other on the new one.
    const store = createUndoableStore({ n: 0 });
    const { useStore } = createStoreHooks(store);

    function Left(): React.ReactElement {
      return <span data-testid="left">{useStore((s) => s.n)}</span>;
    }
    function Right(): React.ReactElement {
      return <span data-testid="right">{useStore((s) => s.n * 2)}</span>;
    }

    function App(): React.ReactElement {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        // A low-priority update that React may interleave with the store write.
        React.startTransition(() => force(1));
        store.set({ n: 5 });
      }, []);
      return (
        <>
          <Left />
          <Right />
        </>
      );
    }

    render(<App />);
    expect(screen.getByTestId("left").textContent).toBe("5");
    expect(screen.getByTestId("right").textContent).toBe("10");
  });

  it("does not tear when the store changes between the two reads of a render pass", () => {
    const store = createUndoableStore({ n: 0 });
    const { useStore } = createStoreHooks(store);

    function Row({ id }: { id: string }): React.ReactElement {
      return <span data-testid={id}>{useStore((s) => s.n)}</span>;
    }

    function App(): React.ReactElement {
      return (
        <>
          <Row id="r1" />
          <Row id="r2" />
          <Row id="r3" />
        </>
      );
    }

    render(<App />);
    act(() => {
      React.startTransition(() => {
        store.set({ n: 1 });
      });
      store.set({ n: 2 });
    });

    const values = ["r1", "r2", "r3"].map((id) => screen.getByTestId(id).textContent);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe("2");
  });
});
