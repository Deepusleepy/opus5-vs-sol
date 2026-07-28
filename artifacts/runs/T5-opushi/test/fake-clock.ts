import type { CancelTimer, Clock } from '../src/clock.js';

interface Scheduled {
  readonly id: number;
  readonly at: number;
  readonly onFire: () => void;
}

/** Guards against a test that schedules timers faster than time advances. */
const MAX_STEPS = 10_000;

/**
 * A `Clock` whose time only moves when a test moves it. Every timer is tracked,
 * so `pendingTimers` doubles as a leak check: code that cleans up after itself
 * leaves zero behind.
 */
export class FakeClock implements Clock {
  #now: number;
  #nextId = 1;
  #timers: Scheduled[] = [];

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(delayMs: number, onFire: () => void): CancelTimer {
    const id = this.#nextId++;
    this.#timers.push({ id, at: this.#now + delayMs, onFire });
    return () => {
      this.#remove(id);
    };
  }

  /** Timers scheduled but neither fired nor cancelled. Should be 0 at rest. */
  get pendingTimers(): number {
    return this.#timers.length;
  }

  /** Milliseconds until the next timer fires, or undefined if none is pending. */
  get nextTimerIn(): number | undefined {
    let soonest: number | undefined;
    for (const timer of this.#timers) {
      if (soonest === undefined || timer.at < soonest) soonest = timer.at;
    }
    return soonest === undefined ? undefined : soonest - this.#now;
  }

  /**
   * Advances time by `ms`, firing due timers in scheduled order.
   *
   * Pending promise callbacks are drained *before* each due check, so a timer
   * never fires for work that has already settled, and timers scheduled by a
   * continuation are picked up in the same advance.
   */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (let step = 0; ; step++) {
      if (step > MAX_STEPS) {
        throw new Error('advance did not settle; a timer loop is not converging');
      }
      await flushMicrotasks();
      const due = this.#nextDueBy(target);
      if (due === undefined) {
        if (this.#now === target) return;
        this.#now = target;
        continue;
      }
      this.#now = Math.max(this.#now, due.at);
      this.#remove(due.id);
      due.onFire();
    }
  }

  /** Advances just enough to fire the next pending timer. */
  async advanceToNextTimer(): Promise<void> {
    await flushMicrotasks();
    const next = this.nextTimerIn;
    if (next === undefined) {
      throw new Error('no pending timers');
    }
    await this.advance(next);
  }

  /** Earliest timer due at or before `target`, ties broken by schedule order. */
  #nextDueBy(target: number): Scheduled | undefined {
    let best: Scheduled | undefined;
    for (const timer of this.#timers) {
      if (timer.at > target) continue;
      if (
        best === undefined ||
        timer.at < best.at ||
        (timer.at === best.at && timer.id < best.id)
      ) {
        best = timer;
      }
    }
    return best;
  }

  #remove(id: number): void {
    this.#timers = this.#timers.filter((t) => t.id !== id);
  }
}

/** Lets already-resolved promise chains run to completion. */
export function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** A promise with its resolve/reject exposed, for driving fakes from a test. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject: (error: unknown) => reject(error) };
}
