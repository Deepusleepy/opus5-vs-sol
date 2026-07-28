export type TimerHandle = unknown;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  // Boundary: the platform timer API returns and accepts this exact opaque handle.
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type BackoffPolicy =
  | { readonly type: "fixed"; readonly delayMs: number }
  | {
      readonly type: "exponential";
      readonly baseDelayMs: number;
      readonly maxDelayMs?: number;
      readonly rng?: () => number;
    };

export type RetryEvent =
  | { readonly type: "retry-attempt-start"; readonly attempt: number }
  | {
      readonly type: "retry-attempt-failure";
      readonly attempt: number;
      readonly error: unknown;
    }
  | {
      readonly type: "retry-scheduled";
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly type: "retry-success"; readonly attempt: number }
  | {
      readonly type: "retry-deadline-exceeded";
      readonly lastError: unknown;
    };

export type CircuitState = "closed" | "open" | "half-open";

export type CircuitEvent =
  | {
      readonly type: "circuit-state-change";
      readonly from: CircuitState;
      readonly to: CircuitState;
    }
  | { readonly type: "circuit-rejected"; readonly state: "open" | "half-open" }
  | { readonly type: "circuit-probe-start" };

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

export class AttemptTimeoutError extends Error {
  public constructor(readonly attempt: number) {
    super(`Attempt ${attempt} timed out`);
    this.name = "AttemptTimeoutError";
  }
}

export class DeadlineError extends Error {
  public constructor(cause?: unknown) {
    super("The total retry deadline was exceeded", cause === undefined ? undefined : { cause });
    this.name = "DeadlineError";
  }
}

export class CircuitOpenError extends Error {
  public constructor(readonly state: "open" | "half-open") {
    super(state === "open" ? "The circuit is open" : "A half-open probe is already running");
    this.name = "CircuitOpenError";
  }
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
}

function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  assertFiniteNonNegative(policy.perAttemptTimeoutMs, "perAttemptTimeoutMs");
  assertFiniteNonNegative(policy.totalDeadlineMs, "totalDeadlineMs");
  if (policy.backoff.type === "fixed") {
    assertFiniteNonNegative(policy.backoff.delayMs, "backoff.delayMs");
  } else {
    assertFiniteNonNegative(policy.backoff.baseDelayMs, "backoff.baseDelayMs");
    if (policy.backoff.maxDelayMs !== undefined) {
      assertFiniteNonNegative(policy.backoff.maxDelayMs, "backoff.maxDelayMs");
    }
  }
}

function backoffDelay(policy: BackoffPolicy, failedAttempt: number): number {
  if (policy.type === "fixed") {
    return policy.delayMs;
  }
  const maximum = policy.maxDelayMs ?? Number.MAX_SAFE_INTEGER;
  const exponential = Math.min(maximum, policy.baseDelayMs * 2 ** (failedAttempt - 1));
  const random = policy.rng?.() ?? Math.random();
  const boundedRandom = Math.max(0, Math.min(1, random));
  return exponential * boundedRandom;
}

function deadlineError(lastError: unknown, onEvent: EventHandler | undefined): DeadlineError {
  onEvent?.({ type: "retry-deadline-exceeded", lastError });
  return new DeadlineError(lastError);
}

async function runAttempt<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  attempt: number,
  timeoutMs: number,
  deadlineWins: boolean,
  priorError: unknown,
  clock: Clock,
): Promise<T> {
  const controller = new AbortController();
  let handle: TimerHandle | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    handle = clock.setTimeout(() => {
      const error = deadlineWins ? new DeadlineError(priorError) : new AttemptTimeoutError(attempt);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const operation = Promise.resolve().then(() => fn(attempt, controller.signal));
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (handle !== undefined) {
      clock.clearTimeout(handle);
    }
  }
}

async function waitForBackoff(
  delayMs: number,
  remainingMs: number,
  clock: Clock,
): Promise<boolean> {
  const reachesDeadline = delayMs >= remainingMs;
  const waitMs = reachesDeadline ? remainingMs : delayMs;
  if (waitMs === 0) {
    return reachesDeadline;
  }
  await new Promise<void>((resolve) => {
    clock.setTimeout(resolve, waitMs);
  });
  return reachesDeadline;
}

export async function withRetry<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  validateRetryPolicy(policy);
  const clock = policy.clock ?? systemClock;
  const startedAt = clock.now();
  const deadlineAt = startedAt + policy.totalDeadlineMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const remaining = deadlineAt - clock.now();
    if (remaining <= 0) {
      throw deadlineError(lastError, policy.onEvent);
    }

    policy.onEvent?.({ type: "retry-attempt-start", attempt });
    try {
      const deadlineWins = remaining <= policy.perAttemptTimeoutMs;
      const result = await runAttempt(
        fn,
        attempt,
        Math.min(remaining, policy.perAttemptTimeoutMs),
        deadlineWins,
        lastError,
        clock,
      );
      policy.onEvent?.({ type: "retry-success", attempt });
      return result;
    } catch (error: unknown) {
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

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly clock?: Clock;
  readonly onEvent?: EventHandler;
}

export class CircuitBreaker<T> {
  private stateValue: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly clock: Clock;

  public constructor(
    private readonly fn: () => Promise<T>,
    private readonly options: CircuitBreakerOptions,
  ) {
    if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new RangeError("failureThreshold must be a positive integer");
    }
    assertFiniteNonNegative(options.cooldownMs, "cooldownMs");
    this.clock = options.clock ?? systemClock;
  }

  public get state(): CircuitState {
    return this.stateValue;
  }

  private transition(to: CircuitState): void {
    const from = this.stateValue;
    if (from !== to) {
      this.stateValue = to;
      this.options.onEvent?.({ type: "circuit-state-change", from, to });
    }
  }

  private rejectOpen(state: "open" | "half-open"): never {
    this.options.onEvent?.({ type: "circuit-rejected", state });
    throw new CircuitOpenError(state);
  }

  public async execute(): Promise<T> {
    let probe = false;
    if (this.stateValue === "open") {
      if (this.clock.now() - this.openedAt < this.options.cooldownMs) {
        return this.rejectOpen("open");
      }
      this.transition("half-open");
      probe = true;
      this.options.onEvent?.({ type: "circuit-probe-start" });
    } else if (this.stateValue === "half-open") {
      return this.rejectOpen("half-open");
    }

    try {
      const result = await this.fn();
      this.consecutiveFailures = 0;
      if (probe) {
        this.transition("closed");
      }
      return result;
    } catch (error: unknown) {
      if (probe) {
        this.openedAt = this.clock.now();
        this.transition("open");
      } else {
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

export function formatEvent(event: ResilienceEvent): string {
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
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
