export const systemClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    // Boundary: the platform timer API returns and accepts this exact opaque handle.
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
};
export class AttemptTimeoutError extends Error {
    attempt;
    constructor(attempt) {
        super(`Attempt ${attempt} timed out`);
        this.attempt = attempt;
        this.name = "AttemptTimeoutError";
    }
}
export class DeadlineError extends Error {
    constructor(cause) {
        super("The total retry deadline was exceeded", cause === undefined ? undefined : { cause });
        this.name = "DeadlineError";
    }
}
export class CircuitOpenError extends Error {
    state;
    constructor(state) {
        super(state === "open" ? "The circuit is open" : "A half-open probe is already running");
        this.state = state;
        this.name = "CircuitOpenError";
    }
}
function assertFiniteNonNegative(value, name) {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a finite, non-negative number`);
    }
}
function validateRetryPolicy(policy) {
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
        throw new RangeError("maxAttempts must be a positive integer");
    }
    assertFiniteNonNegative(policy.perAttemptTimeoutMs, "perAttemptTimeoutMs");
    assertFiniteNonNegative(policy.totalDeadlineMs, "totalDeadlineMs");
    if (policy.backoff.type === "fixed") {
        assertFiniteNonNegative(policy.backoff.delayMs, "backoff.delayMs");
    }
    else {
        assertFiniteNonNegative(policy.backoff.baseDelayMs, "backoff.baseDelayMs");
        if (policy.backoff.maxDelayMs !== undefined) {
            assertFiniteNonNegative(policy.backoff.maxDelayMs, "backoff.maxDelayMs");
        }
    }
}
function backoffDelay(policy, failedAttempt) {
    if (policy.type === "fixed") {
        return policy.delayMs;
    }
    const maximum = policy.maxDelayMs ?? Number.MAX_SAFE_INTEGER;
    const exponential = Math.min(maximum, policy.baseDelayMs * 2 ** (failedAttempt - 1));
    const random = policy.rng?.() ?? Math.random();
    const boundedRandom = Math.max(0, Math.min(1, random));
    return exponential * boundedRandom;
}
function deadlineError(lastError, onEvent) {
    onEvent?.({ type: "retry-deadline-exceeded", lastError });
    return new DeadlineError(lastError);
}
async function runAttempt(fn, attempt, timeoutMs, deadlineWins, priorError, clock) {
    const controller = new AbortController();
    let handle;
    const timeout = new Promise((_resolve, reject) => {
        handle = clock.setTimeout(() => {
            const error = deadlineWins ? new DeadlineError(priorError) : new AttemptTimeoutError(attempt);
            controller.abort(error);
            reject(error);
        }, timeoutMs);
    });
    const operation = Promise.resolve().then(() => fn(attempt, controller.signal));
    try {
        return await Promise.race([operation, timeout]);
    }
    finally {
        if (handle !== undefined) {
            clock.clearTimeout(handle);
        }
    }
}
async function waitForBackoff(delayMs, remainingMs, clock) {
    const reachesDeadline = delayMs >= remainingMs;
    const waitMs = reachesDeadline ? remainingMs : delayMs;
    if (waitMs === 0) {
        return reachesDeadline;
    }
    await new Promise((resolve) => {
        clock.setTimeout(resolve, waitMs);
    });
    return reachesDeadline;
}
export async function withRetry(fn, policy) {
    validateRetryPolicy(policy);
    const clock = policy.clock ?? systemClock;
    const startedAt = clock.now();
    const deadlineAt = startedAt + policy.totalDeadlineMs;
    let lastError;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
        const remaining = deadlineAt - clock.now();
        if (remaining <= 0) {
            throw deadlineError(lastError, policy.onEvent);
        }
        policy.onEvent?.({ type: "retry-attempt-start", attempt });
        try {
            const deadlineWins = remaining <= policy.perAttemptTimeoutMs;
            const result = await runAttempt(fn, attempt, Math.min(remaining, policy.perAttemptTimeoutMs), deadlineWins, lastError, clock);
            policy.onEvent?.({ type: "retry-success", attempt });
            return result;
        }
        catch (error) {
            if (error instanceof DeadlineError) {
                throw deadlineError(lastError, policy.onEvent);
            }
            lastError = error;
            policy.onEvent?.({ type: "retry-attempt-failure", attempt, error });
            if (attempt === policy.maxAttempts || !policy.retryOn(error)) {
                throw error;
            }
            const delayMs = backoffDelay(policy.backoff, attempt);
            policy.onEvent?.({ type: "retry-scheduled", attempt, delayMs });
            const backoffRemaining = deadlineAt - clock.now();
            if (backoffRemaining <= 0) {
                throw deadlineError(lastError, policy.onEvent);
            }
            if (await waitForBackoff(delayMs, backoffRemaining, clock)) {
                throw deadlineError(lastError, policy.onEvent);
            }
        }
    }
    throw new Error("Unreachable retry state");
}
export class CircuitBreaker {
    fn;
    options;
    stateValue = "closed";
    consecutiveFailures = 0;
    openedAt = 0;
    clock;
    constructor(fn, options) {
        this.fn = fn;
        this.options = options;
        if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
            throw new RangeError("failureThreshold must be a positive integer");
        }
        assertFiniteNonNegative(options.cooldownMs, "cooldownMs");
        this.clock = options.clock ?? systemClock;
    }
    get state() {
        return this.stateValue;
    }
    transition(to) {
        const from = this.stateValue;
        if (from !== to) {
            this.stateValue = to;
            this.options.onEvent?.({ type: "circuit-state-change", from, to });
        }
    }
    rejectOpen(state) {
        this.options.onEvent?.({ type: "circuit-rejected", state });
        throw new CircuitOpenError(state);
    }
    async execute() {
        let probe = false;
        if (this.stateValue === "open") {
            if (this.clock.now() - this.openedAt < this.options.cooldownMs) {
                return this.rejectOpen("open");
            }
            this.transition("half-open");
            probe = true;
            this.options.onEvent?.({ type: "circuit-probe-start" });
        }
        else if (this.stateValue === "half-open") {
            return this.rejectOpen("half-open");
        }
        try {
            const result = await this.fn();
            this.consecutiveFailures = 0;
            if (probe) {
                this.transition("closed");
            }
            return result;
        }
        catch (error) {
            if (probe) {
                this.openedAt = this.clock.now();
                this.transition("open");
            }
            else {
                this.consecutiveFailures += 1;
                if (this.consecutiveFailures >= this.options.failureThreshold) {
                    this.openedAt = this.clock.now();
                    this.transition("open");
                }
            }
            throw error;
        }
    }
}
export function formatEvent(event) {
    switch (event.type) {
        case "retry-attempt-start":
            return `attempt ${event.attempt} started`;
        case "retry-attempt-failure":
            return `attempt ${event.attempt} failed`;
        case "retry-scheduled":
            return `retry after ${event.delayMs}ms`;
        case "retry-success":
            return `attempt ${event.attempt} succeeded`;
        case "retry-deadline-exceeded":
            return "retry deadline exceeded";
        case "circuit-state-change":
            return `circuit ${event.from} -> ${event.to}`;
        case "circuit-rejected":
            return `circuit rejected in ${event.state}`;
        case "circuit-probe-start":
            return "circuit probe started";
        default: {
            const exhaustive = event;
            return exhaustive;
        }
    }
}
//# sourceMappingURL=index.js.map