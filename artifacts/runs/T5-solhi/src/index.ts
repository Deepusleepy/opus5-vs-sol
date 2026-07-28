export interface TimerHandle {
  cancel(): void;
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    return {
      cancel: () => globalThis.clearTimeout(handle),
    };
  },
};

export type RetryBackoff =
  | { readonly kind: "fixed"; readonly delayMs: number }
  | {
      readonly kind: "exponential";
      readonly baseDelayMs: number;
      readonly maxDelayMs: number;
      readonly rng?: () => number;
    };

export type RetryEvent =
  | { readonly type: "retry-attempt-started"; readonly attempt: number }
  | { readonly type: "retry-attempt-succeeded"; readonly attempt: number }
  | {
      readonly type: "retry-attempt-failed";
      readonly attempt: number;
      readonly error: unknown;
      readonly willRetry: boolean;
    }
  | {
      readonly type: "retry-scheduled";
      readonly afterAttempt: number;
      readonly delayMs: number;
    };

export type CircuitState = "closed" | "open" | "half-open";

export type CircuitEvent =
  | {
      readonly type: "circuit-state-changed";
      readonly from: CircuitState;
      readonly to: CircuitState;
    }
  | {
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

export class TimeoutError extends Error {
  public constructor() {
    super("Retry attempt timed out");
    this.name = "TimeoutError";
  }
}

export class DeadlineError extends Error {
  public constructor(cause: unknown) {
    super("Retry deadline exceeded", { cause });
    this.name = "DeadlineError";
  }
}

interface AttemptLimit {
  readonly delayMs: number;
  readonly error: TimeoutError | DeadlineError;
}

function emit(handler: EventHandler | undefined, event: ResilienceEvent): void {
  if (handler !== undefined) {
    handler(event);
  }
}

function requireNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  if (policy.backoff.kind === "fixed") {
    requireNonNegativeFinite(policy.backoff.delayMs, "backoff.delayMs");
  } else {
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

function attemptLimit(
  clock: Clock,
  attemptTimeoutMs: number | undefined,
  deadlineAt: number | undefined,
  deadlineCause: unknown,
): AttemptLimit | undefined {
  let limit: AttemptLimit | undefined;

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

function runAttempt<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  attempt: number,
  clock: Clock,
  limit: AttemptLimit | undefined,
): Promise<T> {
  const controller = new AbortController();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: TimerHandle | undefined;

    const clearTimer = (): void => {
      if (timer !== undefined) {
        timer.cancel();
        timer = undefined;
      }
    };

    const succeed = (value: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      resolve(value);
    };

    const fail = (error: unknown): void => {
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

function backoffDelay(backoff: RetryBackoff, failedAttempt: number): number {
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

function waitForBackoff(
  clock: Clock,
  delayMs: number,
  deadlineAt: number | undefined,
  lastError: unknown,
): Promise<void> {
  if (deadlineAt === undefined) {
    if (delayMs === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
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
  return new Promise<void>((resolve, reject) => {
    clock.setTimeout(() => {
      if (deadlineFirst) {
        reject(new DeadlineError(lastError));
      } else {
        resolve();
      }
    }, waitMs);
  });
}

export async function withRetry<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  validateRetryPolicy(policy);

  const clock = policy.clock ?? systemClock;
  const deadlineAt =
    policy.totalDeadlineMs === undefined
      ? undefined
      : clock.now() + policy.totalDeadlineMs;
  let lastError: unknown = undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const limit = attemptLimit(
      clock,
      policy.attemptTimeoutMs,
      deadlineAt,
      lastError,
    );
    if (limit?.error instanceof DeadlineError && limit.delayMs === 0) {
      throw limit.error;
    }

    emit(policy.onEvent, { type: "retry-attempt-started", attempt });
    try {
      const value = await runAttempt(fn, attempt, clock, limit);
      emit(policy.onEvent, { type: "retry-attempt-succeeded", attempt });
      return value;
    } catch (error: unknown) {
      if (error instanceof DeadlineError) {
        throw error;
      }

      lastError = error;
      const willRetry =
        attempt < policy.maxAttempts && policy.retryOn(error);
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

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly clock?: Clock;
  readonly onEvent?: EventHandler;
}

export class CircuitOpenError extends Error {
  public readonly state: "open" | "half-open";

  public constructor(state: "open" | "half-open") {
    super(`Circuit is ${state}`);
    this.name = "CircuitOpenError";
    this.state = state;
  }
}

export class CircuitBreaker<T> {
  readonly #fn: () => Promise<T>;
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #clock: Clock;
  readonly #onEvent: EventHandler | undefined;

  #state: CircuitState = "closed";
  #consecutiveFailures = 0;
  #openedAt = 0;

  public constructor(fn: () => Promise<T>, options: CircuitBreakerOptions) {
    if (
      !Number.isInteger(options.failureThreshold) ||
      options.failureThreshold < 1
    ) {
      throw new RangeError("failureThreshold must be a positive integer");
    }
    requireNonNegativeFinite(options.cooldownMs, "cooldownMs");

    this.#fn = fn;
    this.#failureThreshold = options.failureThreshold;
    this.#cooldownMs = options.cooldownMs;
    this.#clock = options.clock ?? systemClock;
    this.#onEvent = options.onEvent;
  }

  public get state(): CircuitState {
    return this.#state;
  }

  public async execute(): Promise<T> {
    const probe = this.#admitCall();

    try {
      const value = await this.#fn();
      this.#recordSuccess(probe);
      return value;
    } catch (error: unknown) {
      this.#recordFailure(probe);
      throw error;
    }
  }

  #admitCall(): boolean {
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

  #rejectCall(state: "open" | "half-open"): never {
    emit(this.#onEvent, { type: "circuit-call-rejected", state });
    throw new CircuitOpenError(state);
  }

  #recordSuccess(probe: boolean): void {
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

  #recordFailure(probe: boolean): void {
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

  #transitionTo(next: CircuitState): void {
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
