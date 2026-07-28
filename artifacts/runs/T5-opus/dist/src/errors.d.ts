/** Thrown when a single attempt exceeds the per-attempt timeout. */
export declare class TimeoutError extends Error {
    readonly attempt: number;
    readonly timeoutMs: number;
    readonly name = "TimeoutError";
    constructor(attempt: number, timeoutMs: number);
}
/** Thrown when the total deadline for the whole retry loop expires. */
export declare class DeadlineError extends Error {
    readonly name = "DeadlineError";
    constructor(message: string, options?: {
        cause: unknown;
    });
}
/** Thrown by a breaker that is open (or half-open with a probe already running). */
export declare class CircuitOpenError extends Error {
    readonly state: 'open' | 'half-open';
    readonly name = "CircuitOpenError";
    constructor(state: 'open' | 'half-open');
}
