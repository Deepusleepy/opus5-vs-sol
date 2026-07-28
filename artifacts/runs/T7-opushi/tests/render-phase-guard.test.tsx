import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import * as React from "react";
import { createUndoableStore, isRenderPhase } from "../src/index.js";

/**
 * React logs component errors to console.error even when an error boundary
 * handles them. Silence that for a single render so the output stays readable.
 */
function renderExpectingError(element: React.ReactElement): unknown {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  let caught: unknown = null;
  try {
    render(<Boundary onError={(error) => (caught = error)}>{element}</Boundary>);
  } finally {
    spy.mockRestore();
  }
  return caught;
}

class Boundary extends React.Component<
  { readonly children: React.ReactNode; readonly onError: (e: unknown) => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

describe("render-phase mutation guard", () => {
  it("throws a descriptive error when set is called during render", () => {
    const store = createUndoableStore(0);

    function Bad(): React.ReactElement {
      store.set(1); // the classic bug
      return <span />;
    }

    const error = renderExpectingError(<Bad />);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("set()");
    expect(message).toContain("during render");
    // The message must actually tell you what to do about it.
    expect(message).toMatch(/event handler|effect/i);
  });

  it("leaves the store untouched when a render-phase set is rejected", () => {
    const store = createUndoableStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    function Bad(): React.ReactElement {
      store.set(99);
      return <span />;
    }
    renderExpectingError(<Bad />);

    expect(store.get()).toBe(0);
    expect(store.canUndo()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("throws when transact is called during render", () => {
    const store = createUndoableStore(0);

    function Bad(): React.ReactElement {
      store.transact(() => {
        store.set(1);
      });
      return <span />;
    }

    const error = renderExpectingError(<Bad />);
    expect((error as Error).message).toContain("transact()");
  });

  it("throws when undo is called during render", () => {
    const store = createUndoableStore(0);
    store.set(1);

    function Bad(): React.ReactElement {
      store.undo();
      return <span />;
    }

    const error = renderExpectingError(<Bad />);
    expect((error as Error).message).toContain("undo()");
    expect(store.get()).toBe(1);
  });

  it("throws when redo is called during render", () => {
    const store = createUndoableStore(0);
    store.set(1);
    store.undo();

    function Bad(): React.ReactElement {
      store.redo();
      return <span />;
    }

    const error = renderExpectingError(<Bad />);
    expect((error as Error).message).toContain("redo()");
  });

  it("throws for a set inside a useMemo callback", () => {
    // useMemo bodies run during render, so they are just as unsafe.
    const store = createUndoableStore(0);

    function Bad(): React.ReactElement {
      React.useMemo(() => {
        store.set(1);
      }, []);
      return <span />;
    }

    const error = renderExpectingError(<Bad />);
    expect((error as Error).message).toContain("set()");
  });

  it("allows get() during render", () => {
    const store = createUndoableStore(7);
    let seen: number | null = null;

    function Good(): React.ReactElement {
      seen = store.get();
      return <span />;
    }
    render(<Good />);

    expect(seen).toBe(7);
  });

  describe("allows writes from every phase that is not render", () => {
    it("allows set in an effect", () => {
      const store = createUndoableStore(0);

      function Good(): React.ReactElement {
        React.useEffect(() => {
          store.set(1);
        }, []);
        return <span />;
      }
      render(<Good />);

      expect(store.get()).toBe(1);
    });

    it("allows set in a layout effect", () => {
      const store = createUndoableStore(0);

      function Good(): React.ReactElement {
        React.useLayoutEffect(() => {
          store.set(2);
        }, []);
        return <span />;
      }
      render(<Good />);

      expect(store.get()).toBe(2);
    });

    it("allows set in an event handler", () => {
      const store = createUndoableStore(0);

      function Good(): React.ReactElement {
        return (
          <button
            type="button"
            onClick={() => {
              store.set(3);
            }}
          >
            go
          </button>
        );
      }
      const view = render(<Good />);
      act(() => {
        view.getByRole("button").click();
      });

      expect(store.get()).toBe(3);
    });

    it("allows set from outside React entirely", () => {
      const store = createUndoableStore(0);
      store.set(4);
      expect(store.get()).toBe(4);
    });

    it("allows set from a timer that fires after a render", async () => {
      const store = createUndoableStore(0);

      function Component(): React.ReactElement {
        return <span />;
      }
      render(<Component />);

      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            store.set(5);
            resolve();
          }, 0);
        });
      });

      expect(store.get()).toBe(5);
    });
  });

  describe("isRenderPhase", () => {
    it("is false outside React", () => {
      expect(isRenderPhase()).toBe(false);
    });

    it("is true inside a component body and false again afterwards", () => {
      let during: boolean | null = null;

      function Probe(): React.ReactElement {
        during = isRenderPhase();
        return <span />;
      }
      render(<Probe />);

      expect(during).toBe(true);
      expect(isRenderPhase()).toBe(false);
    });

    it("is false inside effects and event handlers", () => {
      let inEffect: boolean | null = null;
      let inHandler: boolean | null = null;

      function Probe(): React.ReactElement {
        React.useEffect(() => {
          inEffect = isRenderPhase();
        }, []);
        return (
          <button
            type="button"
            onClick={() => {
              inHandler = isRenderPhase();
            }}
          >
            go
          </button>
        );
      }
      const view = render(<Probe />);
      act(() => {
        view.getByRole("button").click();
      });

      expect(inEffect).toBe(false);
      expect(inHandler).toBe(false);
    });
  });
});
