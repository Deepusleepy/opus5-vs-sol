/** Cancels a pending timer. Safe to call after the timer has fired. */
export type CancelTimer = () => void;

/**
 * The only time-dependent capability this library uses. Injecting it keeps
 * every test deterministic: no real delays, no wall-clock tolerances.
 */
export interface Clock {
  /** Monotonically non-decreasing milliseconds; only differences are used. */
  now(): number;
  /** Schedules `onFire` roughly `delayMs` in the future. */
  setTimer(delayMs: number, onFire: () => void): CancelTimer;
}

/** Real time, backed by `Date.now` and `setTimeout`. */
export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
  setTimer(delayMs: number, onFire: () => void): CancelTimer {
    const handle = setTimeout(onFire, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

/** Resolves after `delayMs` on the given clock. */
export function delay(clock: Clock, delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    clock.setTimer(delayMs, resolve);
  });
}
