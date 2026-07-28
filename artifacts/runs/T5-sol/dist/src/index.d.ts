export type TimerHandle = unknown;
export interface Clock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
}
export declare const systemClock: Clock;
export type BackoffPolicy = {
    readonly type: "fixed";
    readonly delayMs: number;
} | {
    readonly type: "exponential";
    readonly baseDelayMs: number;
    readonly maxDelayMs?: number;
    readonly rng?: () => number;
};
export type RetryEvent = {
    readonly type: "retry-attempt-start";
    readonly attempt: number;
} | {
    readonly type: "retry-attempt-failure";
    readonly attempt: number;
    readonly error: unknown;
} | {
    readonly type: "retry-scheduled";
    readonly attempt: number;
    readonly delayMs: number;
} | {
    readonly type: "retry-success";
    readonly attempt: number;
} | {
    readonly type: "retry-deadline-exceeded";
    readonly lastError: unknown;
};
export type CircuitState = "closed" | "open" | "half-open";
export type CircuitEvent = {
    readonly type: "circuit-state-change";
    readonly from: CircuitState;
    readonly to: CircuitState;
} | {
    readonly type: "circuit-rejected";
    readonly state: "open" | "half-open";
} | {
    readonly type: "circuit-probe-start";
};
export type ResilienceEvent = RetryEvent | CircuitEvent;
export type EventHandler = (event: ResilienceEvent) => void;
export interface RetryPolicy {
    readonly maxAttempts: number;
    readonly backoff: BackoffPolicy;
    readonly perAttemptTimeoutMs: number;
    readonly totalDeadlineMs: number;
    readonly retryOn: (error: unknown) => boolean;
    readonly clock?: Clock;
    readonly onEvent?: EventHandler;
}
export declare class AttemptTimeoutError extends Error {
    readonly attempt: number;
    constructor(attempt: number);
}
export declare class DeadlineError extends Error {
    constructor(cause?: unknown);
}
export declare class CircuitOpenError extends Error {
    readonly state: "open" | "half-open";
    constructor(state: "open" | "half-open");
}
export declare function withRetry<T>(fn: (attempt: number, signal: AbortSignal) => Promise<T>, policy: RetryPolicy): Promise<T>;
export interface CircuitBreakerOptions {
    readonly failureThreshold: number;
    readonly cooldownMs: number;
    readonly clock?: Clock;
    readonly onEvent?: EventHandler;
}
export declare class CircuitBreaker<T> {
    private readonly fn;
    private readonly options;
    private stateValue;
    private consecutiveFailures;
    private openedAt;
    private readonly clock;
    constructor(fn: () => Promise<T>, options: CircuitBreakerOptions);
    get state(): CircuitState;
    private transition;
    private rejectOpen;
    execute(): Promise<T>;
}
export declare function formatEvent(event: ResilienceEvent): string;
