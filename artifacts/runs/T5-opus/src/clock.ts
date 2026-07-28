/** Cancels a pending timer. Idempotent. */
export type CancelTimer = () => void;

/**
 * Minimal time abstraction. Everything time-dependent in this library goes
 * through a Clock so tests can be fully deterministic.
 */
export interface Clock {
  /** Monotonic-ish milliseconds. Only differences are meaningful. */
  now(): number;
  /** Schedules `cb` after `delayMs`; returns a canceller. */
  setTimer(delayMs: number, cb: () => void): CancelTimer;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(delayMs, cb) {
    const handle = setTimeout(cb, delayMs);
    return () => clearTimeout(handle);
  },
};

/** Sleeps on the clock; rejects with `signal.reason` if aborted first. */
export function sleep(clock: Clock, delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      const reason: unknown = signal.reason;
      reject(reason);
      return;
    }
    const cancel = clock.setTimer(delayMs, () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    function onAbort(): void {
      cancel();
      const reason: unknown = signal?.reason;
      reject(reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
