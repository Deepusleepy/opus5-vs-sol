import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import * as React from "react";
import { createUndoableStore } from "../src/index.js";

/**
 * Notes on what is and is not proven here.
 *
 * Tearing = two components committed in the same pass showing values from two
 * different store states. `useSyncExternalStore` is what prevents it: React
 * re-reads every subscribed snapshot before committing and, if one moved,
 * discards the in-progress render and re-renders synchronously.
 *
 * That guarantee cannot be honestly *demonstrated* in jsdom: reproducing a tear
 * needs a render that is actually interrupted mid-pass, and under `act()` (and
 * in this environment generally) React finishes the pass synchronously. A
 * "tearing test" here passes just as happily against a `useState` + `useEffect`
 * store, which really does tear in a browser — so it would prove nothing. That
 * check was tried against a deliberately tear-prone implementation, was not
 * distinguishing, and was removed rather than left in as false assurance.
 *
 * What follows are the concurrency-adjacent properties this environment *can*
 * decide: the getSnapshot caching contract (whose violation is a hard failure),
 * and consistency across transition-driven updates.
 */
describe("useSyncExternalStore contract", () => {
  it("does not loop when the selector builds a fresh object each call", () => {
    // Without snapshot caching, React sees a new value on every read and warns
    // "The result of getSnapshot should be cached to avoid an infinite loop",
    // then dies with "Maximum update depth exceeded". Verified: removing the
    // cache in `useStoreSlice` makes this test fail exactly that way.
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(String(args[0]));
      });

    const store = createUndoableStore({ a: 1, b: 2 });
    let renders = 0;

    function Sum(): React.ReactElement {
      renders += 1;
      const derived = store.useStore((current: { a: number; b: number }) => ({
        sum: current.a + current.b,
      }));
      return <span data-testid="sum">{derived.sum}</span>;
    }

    try {
      render(<Sum />);
      expect(renders).toBe(1);

      act(() => {
        store.set({ a: 5, b: 5 });
      });

      expect(screen.getByTestId("sum").textContent).toBe("10");
      expect(renders).toBe(2);
      expect(errors.join("\n")).not.toContain("getSnapshot");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns a stable snapshot across re-renders for a stable selector", () => {
    // The caching contract: with a stable selector, repeated reads while the
    // store has not changed return the identical object, so React can bail out
    // and downstream memoization is not invalidated.
    const store = createUndoableStore({ n: 1 });
    const selectDoubled = (current: { n: number }): { doubled: number } => ({
      doubled: current.n * 2,
    });
    const seen: Array<{ doubled: number }> = [];
    let forceRerender = (): void => {};

    function Derived(): React.ReactElement {
      const [, setTick] = React.useState(0);
      forceRerender = () => setTick((tick) => tick + 1);
      seen.push(store.useStore(selectDoubled));
      return <span />;
    }

    render(<Derived />);
    act(() => {
      forceRerender();
    });

    expect(seen.length).toBeGreaterThan(1);
    for (const entry of seen) expect(entry).toBe(seen[0]);
  });

  it("rebuilds the snapshot cache when the selector identity changes", () => {
    // Documents a real limitation rather than asserting it away: the cache
    // lives in a `useMemo` keyed on the selector, so an inline selector that
    // builds a fresh object yields a new identity on each re-render. This is
    // safe (no loop — see the test above) but costs referential stability.
    // Pass a hoisted selector, or an `isEqual`, when that matters.
    const store = createUndoableStore({ n: 1 });
    const seen: Array<{ doubled: number }> = [];
    let forceRerender = (): void => {};

    function Derived(): React.ReactElement {
      const [, setTick] = React.useState(0);
      forceRerender = () => setTick((tick) => tick + 1);
      seen.push(
        store.useStore((current: { n: number }) => ({
          doubled: current.n * 2,
        })),
      );
      return <span />;
    }

    render(<Derived />);
    act(() => {
      forceRerender();
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]); // new identity...
    expect(seen[1]).toStrictEqual(seen[0]); // ...but the same value

    // `isEqual` alone does NOT rescue this: the cache is keyed on the selector,
    // so a new selector identity discards the previous selection before the
    // comparator can be consulted.
    const withComparator: Array<{ doubled: number }> = [];
    const sameDoubled = (
      a: { doubled: number },
      b: { doubled: number },
    ): boolean => a.doubled === b.doubled;

    function WithComparator(): React.ReactElement {
      const [, setTick] = React.useState(0);
      forceRerender = () => setTick((tick) => tick + 1);
      withComparator.push(
        store.useStore(
          (current: { n: number }) => ({ doubled: current.n * 2 }),
          sameDoubled,
        ),
      );
      return <span />;
    }

    render(<WithComparator />);
    act(() => {
      forceRerender();
    });
    expect(withComparator).toHaveLength(2);
    expect(withComparator[1]).not.toBe(withComparator[0]);

    // Hoisting the selector out of the component is the fix: the cache then
    // survives re-renders and the identity is stable.
    const hoisted: Array<{ doubled: number }> = [];
    const selectDoubled = (current: { n: number }): { doubled: number } => ({
      doubled: current.n * 2,
    });

    function Hoisted(): React.ReactElement {
      const [, setTick] = React.useState(0);
      forceRerender = () => setTick((tick) => tick + 1);
      hoisted.push(store.useStore(selectDoubled));
      return <span />;
    }

    render(<Hoisted />);
    act(() => {
      forceRerender();
    });

    expect(hoisted).toHaveLength(2);
    expect(hoisted[1]).toBe(hoisted[0]);
  });
});

describe("updates driven through startTransition", () => {
  it("leaves every reader agreeing with the store", () => {
    const store = createUndoableStore(0);
    const READERS = 12;

    function Reader({ id }: { readonly id: number }): React.ReactElement {
      const value = store.useStore((current: number) => current);
      return <span data-testid={`r${String(id)}`}>{value}</span>;
    }

    render(
      <>
        {Array.from({ length: READERS }, (_, i) => (
          <Reader key={i} id={i} />
        ))}
      </>,
    );

    act(() => {
      React.startTransition(() => {
        store.set(1);
      });
      store.set(2); // higher-priority write while the transition is pending
    });

    const values = Array.from({ length: READERS }, (_, i) =>
      screen.getByTestId(`r${String(i)}`).textContent,
    );
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe(String(store.get()));
  });

  it("keeps two different slices of one write consistent", () => {
    const store = createUndoableStore({ a: 0, b: 0 });

    function A(): React.ReactElement {
      const a = store.useStore((current: { a: number }) => current.a);
      return <span data-testid="a">{a}</span>;
    }
    function B(): React.ReactElement {
      const b = store.useStore((current: { b: number }) => current.b);
      return <span data-testid="b">{b}</span>;
    }

    render(
      <>
        <A />
        <B />
      </>,
    );

    for (let i = 1; i <= 10; i += 1) {
      act(() => {
        React.startTransition(() => {
          store.set({ a: i, b: i }); // the two fields always move together
        });
        if (i % 2 === 0) store.set({ a: i * 10, b: i * 10 });
      });
      expect(screen.getByTestId("a").textContent).toBe(
        screen.getByTestId("b").textContent,
      );
    }

    expect(screen.getByTestId("a").textContent).toBe(String(store.get().a));
  });

  it("ends on the committed value when history moves mid-transition", () => {
    const store = createUndoableStore("start");
    store.set("changed");

    function View(): React.ReactElement {
      const value = store.useStore((current: string) => current);
      return <span data-testid="value">{value}</span>;
    }

    render(<View />);
    expect(screen.getByTestId("value").textContent).toBe("changed");

    act(() => {
      React.startTransition(() => {
        store.set("in transition");
      });
      store.undo();
    });

    expect(screen.getByTestId("value").textContent).toBe(store.get());
  });
});
