/** A single attempt exceeded the per-attempt timeout. */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
  /** The per-attempt budget, in milliseconds, that was exceeded. */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The total deadline for the whole retry sequence expired. `cause` carries the
 * last underlying error, when one attempt had already failed.
 */
export class DeadlineError extends Error {
  override readonly name = 'DeadlineError';
  /** The total budget, in milliseconds, that was exceeded. */
  readonly deadlineMs: number;
  /** Attempts started before the deadline expired. */
  readonly attempts: number;

  constructor(
    message: string,
    deadlineMs: number,
    attempts: number,
    cause: unknown,
  ) {
    super(message, { cause });
    this.deadlineMs = deadlineMs;
    this.attempts = attempts;
  }
}

/** Why a circuit breaker refused to run the wrapped function. */
export type CircuitRejectReason =
  /** The circuit is open and still cooling down. */
  | 'open'
  /** The circuit is half-open and its single probe is already in flight. */
  | 'probe_in_flight';

/** The circuit breaker rejected the call without invoking the wrapped function. */
export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
  readonly reason: CircuitRejectReason;
  /** Milliseconds until the circuit will admit a probe. 0 once cooled down. */
  readonly retryAfterMs: number;

  constructor(reason: CircuitRejectReason, retryAfterMs: number) {
    super(
      reason === 'open'
        ? `circuit is open; retry in ${retryAfterMs}ms`
        : 'circuit is half-open and a probe is already in flight',
    );
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}
