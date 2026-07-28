import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import * as React from "react";
import { createUndoableStore, useStoreSlice } from "../src/index.js";
import type { ReadableStore } from "../src/index.js";

interface Doc {
  readonly title: string;
  readonly count: number;
  readonly tags: readonly string[];
}

const doc: Doc = { title: "hello", count: 0, tags: ["a"] };

describe("useStore selective re-rendering", () => {
  it("re-renders only when the selected slice changes", () => {
    const store = createUndoableStore(doc);
    let titleRenders = 0;
    let countRenders = 0;

    const selectTitle = (value: Doc): string => value.title;
    const selectCount = (value: Doc): number => value.count;

    function Title(): React.ReactElement {
      titleRenders += 1;
      return <span data-testid="title">{store.useStore(selectTitle)}</span>;
    }
    function Count(): React.ReactElement {
      countRenders += 1;
      return <span data-testid="count">{store.useStore(selectCount)}</span>;
    }

    render(
      <>
        <Title />
        <Count />
      </>,
    );
    expect(titleRenders).toBe(1);
    expect(countRenders).toBe(1);

    // Change only `count`.
    act(() => {
      store.set((previous) => ({ ...previous, count: previous.count + 1 }));
    });
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(countRenders).toBe(2);
    expect(titleRenders).toBe(1); // untouched slice: no re-render

    // Change only `title`.
    act(() => {
      store.set((previous) => ({ ...previous, title: "world" }));
    });
    expect(screen.getByTestId("title").textContent).toBe("world");
    expect(titleRenders).toBe(2);
    expect(countRenders).toBe(2);
  });

  it("does not re-render when an unrelated field changes to a new object", () => {
    const store = createUndoableStore(doc);
    let renders = 0;
    const selectTitle = (value: Doc): string => value.title;

    function Title(): React.ReactElement {
      renders += 1;
      return <span>{store.useStore(selectTitle)}</span>;
    }

    render(<Title />);
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        store.set((previous) => ({ ...previous, count: previous.count + 1 }));
      });
    }

    expect(store.get().count).toBe(5);
    expect(renders).toBe(1);
  });

  it("re-renders on undo and redo of the selected slice", () => {
    const store = createUndoableStore(doc);
    const selectTitle = (value: Doc): string => value.title;

    function Title(): React.ReactElement {
      return <span data-testid="title">{store.useStore(selectTitle)}</span>;
    }

    render(<Title />);
    act(() => {
      store.set((previous) => ({ ...previous, title: "changed" }));
    });
    expect(screen.getByTestId("title").textContent).toBe("changed");

    act(() => {
      store.undo();
    });
    expect(screen.getByTestId("title").textContent).toBe("hello");

    act(() => {
      store.redo();
    });
    expect(screen.getByTestId("title").textContent).toBe("changed");
  });

  it("renders once for a transaction that changes the slice several times", () => {
    const store = createUndoableStore(doc);
    let renders = 0;
    const selectCount = (value: Doc): number => value.count;

    function Count(): React.ReactElement {
      renders += 1;
      return <span data-testid="count">{store.useStore(selectCount)}</span>;
    }

    render(<Count />);
    expect(renders).toBe(1);

    act(() => {
      store.transact(() => {
        store.set((previous) => ({ ...previous, count: 1 }));
        store.set((previous) => ({ ...previous, count: 2 }));
        store.set((previous) => ({ ...previous, count: 3 }));
      });
    });

    expect(screen.getByTestId("count").textContent).toBe("3");
    expect(renders).toBe(2); // exactly one re-render for the whole batch
  });

  describe("selector identity", () => {
    it("subscribes exactly once across many selector identity changes", () => {
      // `useStore` delegates to `useStoreSlice`, so passing an instrumented
      // store there lets us count the subscriptions React actually performs
      // rather than merely asserting that a reference looks stable.
      const store = createUndoableStore(doc);
      let subscribeCalls = 0;
      let unsubscribeCalls = 0;
      const counting: ReadableStore<Doc> = {
        get: store.get,
        subscribe: (listener) => {
          subscribeCalls += 1;
          const unsubscribe = store.subscribe(listener);
          return () => {
            unsubscribeCalls += 1;
            unsubscribe();
          };
        },
      };

      let forceParent = (): void => {};
      function Child(): React.ReactElement {
        // A brand-new selector function on every single render.
        const title = useStoreSlice(counting, (value: Doc) => value.title);
        return <span data-testid="title">{title}</span>;
      }
      function Parent(): React.ReactElement {
        const [, force] = React.useState(0);
        forceParent = () => force((n) => n + 1);
        return <Child />;
      }

      render(<Parent />);
      expect(subscribeCalls).toBe(1);

      for (let i = 0; i < 5; i += 1) {
        act(() => {
          forceParent();
        });
      }

      // The selector identity changed six times; the subscription must not have.
      expect(subscribeCalls).toBe(1);
      expect(unsubscribeCalls).toBe(0);

      // And the component is still correctly wired to the store.
      act(() => {
        store.set((previous) => ({ ...previous, title: "after churn" }));
      });
      expect(screen.getByTestId("title").textContent).toBe("after churn");
      expect(subscribeCalls).toBe(1);
    });

    it("resubscribes when the store itself changes", () => {
      // Control for the test above: prove the counter can move at all, so
      // "stayed at 1" is a real result and not a dead instrument.
      const first = createUndoableStore(doc);
      const second = createUndoableStore({ ...doc, title: "second" });
      let subscribeCalls = 0;
      const wrap = (store: typeof first): ReadableStore<Doc> => ({
        get: store.get,
        subscribe: (listener) => {
          subscribeCalls += 1;
          return store.subscribe(listener);
        },
      });
      const wrapped = [wrap(first), wrap(second)] as const;

      function Title({ which }: { readonly which: 0 | 1 }): React.ReactElement {
        const source = wrapped[which];
        const title = useStoreSlice(source, (value: Doc) => value.title);
        return <span data-testid="title">{title}</span>;
      }

      const view = render(<Title which={0} />);
      expect(subscribeCalls).toBe(1);

      view.rerender(<Title which={1} />);
      expect(subscribeCalls).toBe(2);
      expect(screen.getByTestId("title").textContent).toBe("second");
    });

    it("keeps a component subscribed after many selector identity changes", () => {
      const store = createUndoableStore(doc);
      let childRenders = 0;
      let forceParent = (): void => {};

      function Child(): React.ReactElement {
        childRenders += 1;
        const count = store.useStore((value: Doc) => value.count);
        return <span data-testid="count">{count}</span>;
      }
      function Parent(): React.ReactElement {
        const [, force] = React.useState(0);
        forceParent = () => force((n) => n + 1);
        return <Child />;
      }

      render(<Parent />);
      const rendersAfterMount = childRenders;

      act(() => {
        forceParent();
      });
      // Parent re-render propagates to the child (no memo), but the store
      // subscription must survive it.
      act(() => {
        store.set((previous) => ({ ...previous, count: 42 }));
      });

      expect(screen.getByTestId("count").textContent).toBe("42");
      expect(childRenders).toBeGreaterThan(rendersAfterMount);
    });
  });

  describe("isEqual", () => {
    it("suppresses re-renders for selections that are equal by the comparator", () => {
      const store = createUndoableStore(doc);
      let renders = 0;
      const selectTags = (value: Doc): readonly string[] => value.tags;
      const sameTags = (a: readonly string[], b: readonly string[]): boolean =>
        a.length === b.length && a.every((tag, i) => tag === b[i]);

      function Tags(): React.ReactElement {
        renders += 1;
        const tags = store.useStore(selectTags, sameTags);
        return <span data-testid="tags">{tags.join(",")}</span>;
      }

      render(<Tags />);
      expect(renders).toBe(1);

      // New array, same contents: no re-render.
      act(() => {
        store.set((previous) => ({ ...previous, tags: ["a"] }));
      });
      expect(renders).toBe(1);

      // Different contents: re-render.
      act(() => {
        store.set((previous) => ({ ...previous, tags: ["a", "b"] }));
      });
      expect(renders).toBe(2);
      expect(screen.getByTestId("tags").textContent).toBe("a,b");
    });

    it("re-renders on every new object identity without a comparator", () => {
      // Contrast with the previous test: this is why `isEqual` exists.
      const store = createUndoableStore(doc);
      let renders = 0;
      const selectTags = (value: Doc): readonly string[] => value.tags;

      function Tags(): React.ReactElement {
        renders += 1;
        const tags = store.useStore(selectTags);
        return <span>{tags.join(",")}</span>;
      }

      render(<Tags />);
      act(() => {
        store.set((previous) => ({ ...previous, tags: ["a"] }));
      });

      expect(renders).toBe(2);
    });

    it("keeps a stable reference for a derived object selection", () => {
      const store = createUndoableStore(doc);
      const seen: Array<{ title: string }> = [];
      const selectSummary = (value: Doc): { title: string } => ({
        title: value.title,
      });
      const sameSummary = (
        a: { title: string },
        b: { title: string },
      ): boolean => a.title === b.title;

      function Summary(): React.ReactElement {
        const summary = store.useStore(selectSummary, sameSummary);
        seen.push(summary);
        return <span>{summary.title}</span>;
      }

      render(<Summary />);
      act(() => {
        // Title unchanged, so the derived object must keep its identity.
        store.set((previous) => ({ ...previous, count: previous.count + 1 }));
      });

      expect(seen.length).toBeGreaterThan(0);
      const first = seen[0];
      for (const summary of seen) expect(summary).toBe(first);
    });
  });

  it("unsubscribes on unmount", () => {
    const store = createUndoableStore(doc);
    let renders = 0;
    const selectCount = (value: Doc): number => value.count;

    function Count(): React.ReactElement {
      renders += 1;
      return <span>{store.useStore(selectCount)}</span>;
    }

    const view = render(<Count />);
    act(() => {
      store.set((previous) => ({ ...previous, count: 1 }));
    });
    const rendersBeforeUnmount = renders;

    view.unmount();
    act(() => {
      store.set((previous) => ({ ...previous, count: 2 }));
    });

    expect(renders).toBe(rendersBeforeUnmount);
  });

  it("shows the current value to a component that mounts later", () => {
    const store = createUndoableStore(doc);
    store.set((previous) => ({ ...previous, title: "already changed" }));

    function Title(): React.ReactElement {
      return (
        <span data-testid="title">
          {store.useStore((value: Doc) => value.title)}
        </span>
      );
    }
    render(<Title />);

    expect(screen.getByTestId("title").textContent).toBe("already changed");
  });

  it("keeps two components reading the same slice consistent", () => {
    const store = createUndoableStore(doc);
    const selectCount = (value: Doc): number => value.count;

    function Count({ id }: { readonly id: string }): React.ReactElement {
      return <span data-testid={id}>{store.useStore(selectCount)}</span>;
    }

    render(
      <>
        <Count id="one" />
        <Count id="two" />
      </>,
    );
    act(() => {
      store.set((previous) => ({ ...previous, count: 9 }));
    });

    expect(screen.getByTestId("one").textContent).toBe("9");
    expect(screen.getByTestId("two").textContent).toBe("9");
  });
});
