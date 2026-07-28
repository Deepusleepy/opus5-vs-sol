import type { CancelTimer, Clock } from '../src/clock.js';
/**
 * Deterministic clock. Time only moves when the test says so, and
 * `pendingTimers` lets tests assert that nothing was left armed.
 */
export declare class FakeClock implements Clock {
    #private;
    constructor(startMs?: number);
    now(): number;
    setTimer(delayMs: number, cb: () => void): CancelTimer;
    get pendingTimers(): number;
    /**
     * Advances time by `ms`, firing due timers in chronological order and
     * draining the microtask queue after each one so awaiting code can react.
     */
    advance(ms: number): Promise<void>;
    /** Fires every armed timer, in order, until none remain (bounded). */
    runAll(limit?: number): Promise<void>;
}
export declare function flushMicrotasks(rounds?: number): Promise<void>;
