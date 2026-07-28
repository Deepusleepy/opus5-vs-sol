import { type Clock } from './clock.js';
import type { EventSink } from './events.js';
export type Backoff = {
    readonly kind: 'fixed';
    readonly delayMs: number;
}
/** delay = random() * min(maxDelayMs, baseMs * 2^(attempt-1))  — full jitter */
 | {
    readonly kind: 'exponential';
    readonly baseMs: number;
    readonly maxDelayMs: number;
};
export interface RetryPolicy {
    /** Total attempts, including the first. Must be >= 1. */
    readonly maxAttempts: number;
    readonly backoff: Backoff;
    /** Abort an attempt that runs longer than this. */
    readonly attemptTimeoutMs?: number;
    /** Wall-clock budget for the whole call, measured from entry. */
    readonly totalDeadlineMs?: number;
    /** Return false to stop retrying and rethrow immediately. */
    readonly retryOn?: (error: unknown) => boolean;
    /** Injectable RNG in [0, 1) for jitter. */
    readonly rng?: () => number;
    readonly clock?: Clock;
    readonly onEvent?: EventSink;
}
/** Backoff delay before the retry that follows `attempt` (1-based). */
export declare function backoffDelay(backoff: Backoff, attempt: number, rng: () => number): number;
export declare function withRetry<T>(fn: (attempt: number, signal: AbortSignal) => Promise<T>, policy: RetryPolicy): Promise<T>;
