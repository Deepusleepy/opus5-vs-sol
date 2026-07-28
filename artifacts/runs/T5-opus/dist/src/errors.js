/** Thrown when a single attempt exceeds the per-attempt timeout. */
export class TimeoutError extends Error {
    attempt;
    timeoutMs;
    name = 'TimeoutError';
    constructor(attempt, timeoutMs) {
        super(`attempt ${attempt} timed out after ${timeoutMs}ms`);
        this.attempt = attempt;
        this.timeoutMs = timeoutMs;
    }
}
/** Thrown when the total deadline for the whole retry loop expires. */
export class DeadlineError extends Error {
    name = 'DeadlineError';
    constructor(message, options) {
        super(message, options);
    }
}
/** Thrown by a breaker that is open (or half-open with a probe already running). */
export class CircuitOpenError extends Error {
    state;
    name = 'CircuitOpenError';
    constructor(state) {
        super(`circuit is ${state}`);
        this.state = state;
    }
}
//# sourceMappingURL=errors.js.map