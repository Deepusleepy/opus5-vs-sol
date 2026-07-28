export const systemClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => {
        const handle = globalThis.setTimeout(callback, delayMs);
        return {
            cancel: () => globalThis.clearTimeout(handle),
        };
    },
};
export class TimeoutError extends Error {
    constructor() {
        super("Retry attempt timed out");
        this.name = "TimeoutError";
    }
}
export class DeadlineError extends Error {
    constructor(cause) {
        super("Retry deadline exceeded", { cause });
        this.name = "DeadlineError";
    }
}
function emit(handler, event) {
    if (handler !== undefined) {
        handler(event);
    }
}
function requireNonNegativeFinite(value, name) {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative finite number`);
    }
}
function validateRetryPolicy(policy) {
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
        throw new RangeError("maxAttempts must be a positive integer");
    }
    if (policy.backoff.kind === "fixed") {
        requireNonNegativeFinite(policy.backoff.delayMs, "backoff.delayMs");
    }
    else {
        requireNonNegativeFinite(policy.backoff.baseDelayMs, "backoff.baseDelayMs");
        requireNonNegativeFinite(policy.backoff.maxDelayMs, "backoff.maxDelayMs");
    }
    if (policy.attemptTimeoutMs !== undefined) {
        requireNonNegativeFinite(policy.attemptTimeoutMs, "attemptTimeoutMs");
    }
    if (policy.totalDeadlineMs !== undefined) {
        requireNonNegativeFinite(policy.totalDeadlineMs, "totalDeadlineMs");
    }
}
function attemptLimit(clock, attemptTimeoutMs, deadlineAt, deadlineCause) {
    let limit;
    if (attemptTimeoutMs !== undefined) {
        limit = { delayMs: attemptTimeoutMs, error: new TimeoutError() };
    }
    if (deadlineAt !== undefined) {
        const remainingMs = deadlineAt - clock.now();
        if (remainingMs <= 0) {
            return { delayMs: 0, error: new DeadlineError(deadlineCause) };
        }
        if (limit === undefined || remainingMs <= limit.delayMs) {
            limit = { delayMs: remainingMs, error: new DeadlineError(deadlineCause) };
        }
    }
    return limit;
}
function runAttempt(fn, attempt, clock, limit) {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const clearTimer = () => {
            if (timer !== undefined) {
                timer.cancel();
                timer = undefined;
            }
        };
        const succeed = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimer();
            resolve(value);
        };
        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimer();
            reject(error);
        };
        if (limit !== undefined) {
            timer = clock.setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                timer = undefined;
                controller.abort(limit.error);
                reject(limit.error);
            }, limit.delayMs);
        }
        Promise.resolve()
            .then(() => fn(attempt, controller.signal))
            .then(succeed, fail);
    });
}
function backoffDelay(backoff, failedAttempt) {
    if (backoff.kind === "fixed") {
        return backoff.delayMs;
    }
    const exponentialCap = backoff.baseDelayMs * 2 ** (failedAttempt - 1);
    const cap = Math.min(backoff.maxDelayMs, exponentialCap);
    const random = (backoff.rng ?? Math.random)();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
        throw new RangeError("backoff.rng must return a number between 0 and 1");
    }
    return Math.floor(random * cap);
}
function waitForBackoff(clock, delayMs, deadlineAt, lastError) {
    if (deadlineAt === undefined) {
        if (delayMs === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            clock.setTimeout(resolve, delayMs);
        });
    }
    const remainingMs = deadlineAt - clock.now();
    if (remainingMs <= 0) {
        return Promise.reject(new DeadlineError(lastError));
    }
    if (delayMs === 0) {
        return Promise.resolve();
    }
    const deadlineFirst = remainingMs <= delayMs;
    const waitMs = deadlineFirst ? remainingMs : delayMs;
    return new Promise((resolve, reject) => {
        clock.setTimeout(() => {
            if (deadlineFirst) {
                reject(new DeadlineError(lastError));
            }
            else {
                resolve();
            }
        }, waitMs);
    });
}
export async function withRetry(fn, policy) {
    validateRetryPolicy(policy);
    const clock = policy.clock ?? systemClock;
    const deadlineAt = policy.totalDeadlineMs === undefined
        ? undefined
        : clock.now() + policy.totalDeadlineMs;
    let lastError = undefined;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
        const limit = attemptLimit(clock, policy.attemptTimeoutMs, deadlineAt, lastError);
        if (limit?.error instanceof DeadlineError && limit.delayMs === 0) {
            throw limit.error;
        }
        emit(policy.onEvent, { type: "retry-attempt-started", attempt });
        try {
            const value = await runAttempt(fn, attempt, clock, limit);
            emit(policy.onEvent, { type: "retry-attempt-succeeded", attempt });
            return value;
        }
        catch (error) {
            if (error instanceof DeadlineError) {
                throw error;
            }
            lastError = error;
            const willRetry = attempt < policy.maxAttempts && policy.retryOn(error);
            emit(policy.onEvent, {
                type: "retry-attempt-failed",
                attempt,
                error,
                willRetry,
            });
            if (!willRetry) {
                throw error;
            }
            const delayMs = backoffDelay(policy.backoff, attempt);
            emit(policy.onEvent, {
                type: "retry-scheduled",
                afterAttempt: attempt,
                delayMs,
            });
            await waitForBackoff(clock, delayMs, deadlineAt, lastError);
        }
    }
    throw new Error("unreachable retry state");
}
export class CircuitOpenError extends Error {
    state;
    constructor(state) {
        super(`Circuit is ${state}`);
        this.name = "CircuitOpenError";
        this.state = state;
    }
}
export class CircuitBreaker {
    #fn;
    #failureThreshold;
    #cooldownMs;
    #clock;
    #onEvent;
    #state = "closed";
    #consecutiveFailures = 0;
    #openedAt = 0;
    constructor(fn, options) {
        if (!Number.isInteger(options.failureThreshold) ||
            options.failureThreshold < 1) {
            throw new RangeError("failureThreshold must be a positive integer");
        }
        requireNonNegativeFinite(options.cooldownMs, "cooldownMs");
        this.#fn = fn;
        this.#failureThreshold = options.failureThreshold;
        this.#cooldownMs = options.cooldownMs;
        this.#clock = options.clock ?? systemClock;
        this.#onEvent = options.onEvent;
    }
    get state() {
        return this.#state;
    }
    async execute() {
        const probe = this.#admitCall();
        try {
            const value = await this.#fn();
            this.#recordSuccess(probe);
            return value;
        }
        catch (error) {
            this.#recordFailure(probe);
            throw error;
        }
    }
    #admitCall() {
        if (this.#state === "open") {
            if (this.#clock.now() - this.#openedAt >= this.#cooldownMs) {
                this.#transitionTo("half-open");
                return true;
            }
            this.#rejectCall("open");
        }
        if (this.#state === "half-open") {
            this.#rejectCall("half-open");
        }
        return false;
    }
    #rejectCall(state) {
        emit(this.#onEvent, { type: "circuit-call-rejected", state });
        throw new CircuitOpenError(state);
    }
    #recordSuccess(probe) {
        if (probe) {
            if (this.#state === "half-open") {
                this.#consecutiveFailures = 0;
                this.#transitionTo("closed");
            }
            return;
        }
        if (this.#state === "closed") {
            this.#consecutiveFailures = 0;
        }
    }
    #recordFailure(probe) {
        if (probe) {
            if (this.#state === "half-open") {
                this.#openedAt = this.#clock.now();
                this.#transitionTo("open");
            }
            return;
        }
        if (this.#state !== "closed") {
            return;
        }
        this.#consecutiveFailures += 1;
        if (this.#consecutiveFailures >= this.#failureThreshold) {
            this.#openedAt = this.#clock.now();
            this.#transitionTo("open");
        }
    }
    #transitionTo(next) {
        const from = this.#state;
        if (from === next) {
            return;
        }
        this.#state = next;
        emit(this.#onEvent, {
            type: "circuit-state-changed",
            from,
            to: next,
        });
    }
}
//# sourceMappingURL=index.js.map