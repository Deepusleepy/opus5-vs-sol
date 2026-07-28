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
export declare const systemClock: Clock;
/** Sleeps on the clock; rejects with `signal.reason` if aborted first. */
export declare function sleep(clock: Clock, delayMs: number, signal?: AbortSignal): Promise<void>;
