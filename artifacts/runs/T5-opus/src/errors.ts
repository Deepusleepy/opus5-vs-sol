/** Thrown when a single attempt exceeds the per-attempt timeout. */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
  constructor(
    readonly attempt: number,
    readonly timeoutMs: number,
  ) {
    super(`attempt ${attempt} timed out after ${timeoutMs}ms`);
  }
}

/** Thrown when the total deadline for the whole retry loop expires. */
export class DeadlineError extends Error {
  override readonly name = 'DeadlineError';
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
  }
}

/** Thrown by a breaker that is open (or half-open with a probe already running). */
export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
  constructor(readonly state: 'open' | 'half-open') {
    super(`circuit is ${state}`);
  }
}
