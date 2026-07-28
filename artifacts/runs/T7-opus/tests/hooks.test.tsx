import { act, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoreHooks, createUndoableStore } from "../src/index.js";

interface State {
  a: number;
  b: number;
  items: string[];
}

const initial: State = { a: 0, b: 0, items: [] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useStore", () => {
  it("renders the selected slice and updates on change", () => {
    const store = createUndoableStore(initial);
    const { useStore } = createStoreHooks(store);

    function ShowA(): React.ReactElement {
      const a = useStore((s) => s.a);
      return <span data-testid="a">{a}</span>;
    }

    render(<ShowA />);
    expect(screen.getByTestId("a").textContent).toBe("0");
    act(() => {
      store.set((s) => ({ ...s, a: 5 }));
    });
    expect(screen.getByTestId("a").textContent).toBe("5");
  });

  it("re-renders only when the selected slice changes", () => {
    const store = createUndoableStore(initial);
    const { useStore } = createStoreHooks(store);
    let renders = 0;

    function ShowA(): React.ReactElement {
      renders += 1;
      const a = useStore((s) => s.a);
      return <span data-testid="a">{a}</span>;
    }

    render(<ShowA />);
    expect(renders).toBe(1);

    // Unrelated slice: no re-render.
    act(() => {
      store.set((s) => ({ ...s, b: 1 }));
    });
    act(() => {
      store.set((s) => ({ ...s, b: 2 }));
    });
    expect(renders).toBe(1);
    expect(store.get().b).toBe(2);

    // Selected slice: exactly one re-render.
    act(() => {
      store.set((s) => ({ ...s, a: 1 }));
    });
    expect(renders).toBe(2);
    expect(screen.getByTestId("a").textContent).toBe("1");

    // Same value written again: no re-render.
    act(() => {
      store.set((s) => ({ ...s, a: 1, b: 3 }));
    });
    expect(renders).toBe(2);
  });

  it("honours a custom isEqual for referentially-unstable slices", () => {
    const store = createUndoableStore(initial);
    const { useStore } = createStoreHooks(store);
    const shallowArrayEqual = (x: string[], y: string[]): boolean =>
      x.length === y.length && x.every((v, i) => v === y[i]);
    let renders = 0;

    function ShowItems(): React.ReactElement {
      renders += 1;
      // A fresh array every call — without isEqual this would loop or thrash.
      const items = useStore((s) => [...s.items], shallowArrayEqual);
      return <span data-testid="items">{items.join(",")}</span>;
    }

    render(<ShowItems />);
    expect(renders).toBe(1);

    act(() => {
      store.set((s) => ({ ...s, items: [], a: 1 }));
    });
    expect(renders).toBe(1);

    act(() => {
      store.set((s) => ({ ...s, items: ["x"] }));
    });
    expect(renders).toBe(2);
    expect(screen.getByTestId("items").textContent).toBe("x");
  });

  it("does not resubscribe when the selector identity changes", () => {
    const store = createUndoableStore(initial);
    let subscribes = 0;
    let unsubscribes = 0;
    const real = store.subscribe;
    vi.spyOn(store, "subscribe").mockImplementation((listener) => {
      subscribes += 1;
      const off = real(listener);
      return () => {
        unsubscribes += 1;
        off();
      };
    });
    const { useStore } = createStoreHooks(store);
    let renders = 0;

    function Child({ pick }: { pick: "a" | "b" }): React.ReactElement {
      renders += 1;
      // New arrow function on every render, and it changes behaviour too.
      const v = useStore((s) => s[pick]);
      return <span data-testid="v">{v}</span>;
    }

    const { rerender } = render(<Child pick="a" />);
    expect(subscribes).toBe(1);

    rerender(<Child pick="a" />);
    rerender(<Child pick="a" />);
    // Exactly the three renders we asked for: an unstable snapshot function
    // would make React re-render to chase a "changed" store.
    expect(renders).toBe(3);
    expect([subscribes, unsubscribes]).toEqual([1, 0]);

    // Switching which slice is selected also must not resubscribe, and the new
    // selector must take effect immediately.
    act(() => {
      store.set((s) => ({ ...s, b: 42 }));
    });
    rerender(<Child pick="b" />);
    expect([subscribes, unsubscribes]).toEqual([1, 0]);
    expect(screen.getByTestId("v").textContent).toBe("42");
  });

  it("collapses a transaction into a single re-render", () => {
    const store = createUndoableStore(initial);
    const { useStore } = createStoreHooks(store);
    let renders = 0;

    function ShowA(): React.ReactElement {
      renders += 1;
      const a = useStore((s) => s.a);
      return <span data-testid="a">{a}</span>;
    }

    render(<ShowA />);
    act(() => {
      store.transact(() => {
        store.set((s) => ({ ...s, a: 1 }));
        store.set((s) => ({ ...s, a: 2 }));
        store.set((s) => ({ ...s, a: 3 }));
      });
    });
    expect(renders).toBe(2);
    expect(screen.getByTestId("a").textContent).toBe("3");
  });

  it("unsubscribes on unmount", () => {
    const store = createUndoableStore(initial);
    const { useStore } = createStoreHooks(store);
    let renders = 0;

    function ShowA(): React.ReactElement {
      renders += 1;
      return <span>{useStore((s) => s.a)}</span>;
    }

    const { unmount } = render(<ShowA />);
    const before = renders;
    unmount();
    act(() => {
      store.set((s) => ({ ...s, a: 9 }));
    });
    expect(renders).toBe(before);
  });
});

describe("useUndoRedo", () => {
  it("re-renders only when a can-flag flips", () => {
    const store = createUndoableStore(initial);
    const { useUndoRedo } = createStoreHooks(store);
    let renders = 0;
    let latest = { canUndo: false, canRedo: false };

    function Controls(): React.ReactElement {
      renders += 1;
      const { canUndo, canRedo } = useUndoRedo();
      latest = { canUndo, canRedo };
      return <span />;
    }

    render(<Controls />);
    expect(renders).toBe(1);
    expect(latest).toEqual({ canUndo: false, canRedo: false });

    // First set flips canUndo false -> true: one re-render.
    act(() => {
      store.set((s) => ({ ...s, a: 1 }));
    });
    expect(renders).toBe(2);
    expect(latest).toEqual({ canUndo: true, canRedo: false });

    // Further sets do not change either flag: no re-renders.
    act(() => {
      store.set((s) => ({ ...s, a: 2 }));
    });
    act(() => {
      store.set((s) => ({ ...s, a: 3 }));
    });
    expect(renders).toBe(2);

    // Undo flips canRedo: one re-render.
    act(() => {
      store.undo();
    });
    expect(renders).toBe(3);
    expect(latest).toEqual({ canUndo: true, canRedo: true });

    // Another undo leaves both flags set: no re-render.
    act(() => {
      store.undo();
    });
    expect(renders).toBe(3);

    // Undoing to the start flips canUndo off: one re-render.
    act(() => {
      store.undo();
    });
    expect(renders).toBe(4);
    expect(latest).toEqual({ canUndo: false, canRedo: true });
  });

  it("exposes working undo/redo callbacks", () => {
    const store = createUndoableStore(initial);
    const { useUndoRedo } = createStoreHooks(store);
    let api: ReturnType<typeof useUndoRedo> | undefined;

    function Controls(): React.ReactElement {
      api = useUndoRedo();
      return <span />;
    }

    render(<Controls />);
    act(() => {
      store.set((s) => ({ ...s, a: 1 }));
    });
    act(() => {
      api?.undo();
    });
    expect(store.get().a).toBe(0);
    act(() => {
      api?.redo();
    });
    expect(store.get().a).toBe(1);
  });
});

describe("render-phase writes", () => {
  it("throws a descriptive error when set is called during render", () => {
    const store = createUndoableStore(initial);
    // React logs the thrown render error; keep the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});

    function Bad(): React.ReactElement {
      store.set((s) => ({ ...s, a: s.a + 1 }));
      return <span />;
    }

    expect(() => render(<Bad />)).toThrow(/called during a React render/);
    expect(store.get()).toEqual(initial);
  });

  it("throws when transact is called during render", () => {
    const store = createUndoableStore(initial);
    vi.spyOn(console, "error").mockImplementation(() => {});

    function Bad(): React.ReactElement {
      store.transact(() => {
        store.set((s) => ({ ...s, a: 1 }));
      });
      return <span />;
    }

    expect(() => render(<Bad />)).toThrow(/transact\(\) was called during a React render/);
  });

  it("allows set from effects and event handlers", () => {
    const store = createUndoableStore(initial);
    const { useStore } = createStoreHooks(store);

    function Ok(): React.ReactElement {
      const a = useStore((s) => s.a);
      React.useEffect(() => {
        store.set((s) => ({ ...s, a: 1 }));
      }, []);
      return <span data-testid="a">{a}</span>;
    }

    render(<Ok />);
    expect(screen.getByTestId("a").textContent).toBe("1");
  });

  it("allows get during render", () => {
    const store = createUndoableStore(initial);
    function Ok(): React.ReactElement {
      return <span data-testid="a">{store.get().a}</span>;
    }
    render(<Ok />);
    expect(screen.getByTestId("a").textContent).toBe("0");
  });
});

describe("multiple components", () => {
  it("keeps independent subscribers consistent", () => {
    const store = createUndoableStore(initial);
    const { useStore } = createStoreHooks(store);
    let aRenders = 0;
    let bRenders = 0;

    function A(): React.ReactElement {
      aRenders += 1;
      return <span data-testid="a">{useStore((s) => s.a)}</span>;
    }
    function B(): React.ReactElement {
      bRenders += 1;
      return <span data-testid="b">{useStore((s) => s.b)}</span>;
    }

    render(
      <>
        <A />
        <B />
      </>,
    );
    expect([aRenders, bRenders]).toEqual([1, 1]);

    act(() => {
      store.set((s) => ({ ...s, a: 1 }));
    });
    expect([aRenders, bRenders]).toEqual([2, 1]);

    act(() => {
      store.transact(() => {
        store.set((s) => ({ ...s, a: 2 }));
        store.set((s) => ({ ...s, b: 3 }));
      });
    });
    expect([aRenders, bRenders]).toEqual([3, 2]);
    expect(screen.getByTestId("a").textContent).toBe("2");
    expect(screen.getByTestId("b").textContent).toBe("3");
  });
});
