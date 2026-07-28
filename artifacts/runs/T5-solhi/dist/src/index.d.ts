export interface TimerHandle {
    cancel(): void;
}
export interface Clock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
}
export declare const systemClock: Clock;
export type RetryBackoff = {
    readonly kind: "fixed";
    readonly delayMs: number;
} | {
    readonly kind: "exponential";
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly rng?: () => number;
};
export type RetryEvent = {
    readonly type: "retry-attempt-started";
    readonly attempt: number;
} | {
    readonly type: "retry-attempt-succeeded";
    readonly attempt: number;
} | {
    readonly type: "retry-attempt-failed";
    readonly attempt: number;
    readonly error: unknown;
    readonly willRetry: boolean;
} | {
    readonly type: "retry-scheduled";
    readonly afterAttempt: number;
    readonly delayMs: number;
};
export type CircuitState = "closed" | "open" | "half-open";
export type CircuitEvent = {
    readonly type: "circuit-state-changed";
    readonly from: CircuitState;
    readonly to: CircuitState;
} | {
    readonly type: "circuit-call-rejected";
    readonly state: "open" | "half-open";
};
export type ResilienceEvent = RetryEvent | CircuitEvent;
export type EventHandler = (event: ResilienceEvent) => void;
export interface RetryPolicy {
    readonly maxAttempts: number;
    readonly backoff: RetryBackoff;
    readonly attemptTimeoutMs?: number;
    readonly totalDeadlineMs?: number;
    readonly retryOn: (error: unknown) => boolean;
    readonly clock?: Clock;
    readonly onEvent?: EventHandler;
}
export declare class TimeoutError extends Error {
    constructor();
}
export declare class DeadlineError extends Error {
    constructor(cause: unknown);
}
export declare function withRetry<T>(fn: (attempt: number, signal: AbortSignal) => Promise<T>, policy: RetryPolicy): Promise<T>;
export interface CircuitBreakerOptions {
    readonly failureThreshold: number;
    readonly cooldownMs: number;
    readonly clock?: Clock;
    readonly onEvent?: EventHandler;
}
export declare class CircuitOpenError extends Error {
    readonly state: "open" | "half-open";
    constructor(state: "open" | "half-open");
}
export declare class CircuitBreaker<T> {
    #private;
    constructor(fn: () => Promise<T>, options: CircuitBreakerOptions);
    get state(): CircuitState;
    execute(): Promise<T>;
}
