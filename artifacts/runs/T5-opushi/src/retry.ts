import { type Clock, delay, systemClock } from './clock.js';
import { DeadlineError, TimeoutError } from './errors.js';
import type { RetryEvent } from './events.js';

/** How long to wait between attempts. */
export type Backoff =
  /** Always the same delay. */
  | { readonly kind: 'fixed'; readonly delayMs: number }
  /**
   * Full jitter: `random() * min(maxDelayMs, baseMs * 2 ** (attempt - 1))`.
   * The random draw comes from `RetryPolicy.rng`, so it is injectable.
   */
  | {
      readonly kind: 'exponential';
      readonly baseMs: number;
      readonly maxDelayMs: number;
    };

export interface RetryPolicy {
  /** Total attempts, including the first. Must be >= 1. */
  readonly maxAttempts: number;
  readonly backoff: Backoff;
  /** Return true to retry the error, false to fail fast with it. */
  readonly retryOn: (error: unknown) => boolean;
  /** Budget for one attempt. Expiry aborts the attempt's signal. Omit for none. */
  readonly attemptTimeoutMs?: number;
  /** Budget for the whole sequence, measured from the first attempt. */
  readonly totalDeadlineMs?: number;
  /** Defaults to {@link systemClock}. */
  readonly clock?: Clock;
  /** Uniform draw in [0, 1). Defaults to `Math.random`. */
  readonly rng?: () => number;
  readonly onEvent?: (event: RetryEvent) => void;
}

const NO_LIMIT = Number.POSITIVE_INFINITY;

/**
 * Runs `fn` until it succeeds, the policy runs out of attempts, `retryOn`
 * rejects the error, or the total deadline expires.
 *
 * Each attempt receives its 1-based attempt number and an `AbortSignal` that is
 * aborted when that attempt's budget expires. The attempt's timer is always
 * cleared once the attempt settles, so a successful call leaves no pending
 * timers behind.
 */
export async function withRetry<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be an integer >= 1');
  }
  const clock = policy.clock ?? systemClock;
  const emit = policy.onEvent;
  const totalDeadlineMs = policy.totalDeadlineMs;
  const deadlineAt =
    totalDeadlineMs === undefined ? undefined : clock.now() + totalDeadlineMs;

  const remaining = (): number =>
    deadlineAt === undefined ? NO_LIMIT : deadlineAt - clock.now();

  const deadlineExceeded = (attempts: number, cause: unknown): DeadlineError => {
    emit?.({ kind: 'retry.deadline_exceeded', attempts, error: cause });
    return new DeadlineError(
      `retry deadline of ${totalDeadlineMs ?? 0}ms exceeded after ${attempts} attempt(s)`,
      totalDeadlineMs ?? 0,
      attempts,
      cause,
    );
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const left = remaining();
    if (left <= 0) {
      throw deadlineExceeded(attempt - 1, lastError);
    }

    // The attempt is cut short by whichever budget is tighter, and the error
    // it fails with names that budget.
    const attemptTimeoutMs = policy.attemptTimeoutMs ?? NO_LIMIT;
    const budgetMs = Math.min(attemptTimeoutMs, left);
    const expired =
      budgetMs === attemptTimeoutMs
        ? (): Error =>
            new TimeoutError(
              `attempt ${attempt} exceeded its ${attemptTimeoutMs}ms timeout`,
              attemptTimeoutMs,
            )
        : (): Error => deadlineExceeded(attempt, lastError);

    try {
      const value = await runAttempt(fn, attempt, budgetMs, expired, clock);
      emit?.({ kind: 'retry.succeeded', attempt });
      return value;
    } catch (error) {
      if (error instanceof DeadlineError) {
        throw error;
      }
      lastError = error;

      if (!policy.retryOn(error)) {
        emit?.({ kind: 'retry.attempt_failed', attempt, error, willRetry: false });
        emit?.({
          kind: 'retry.gave_up',
          attempts: attempt,
          reason: 'non_retryable',
          error,
        });
        throw error;
      }

      const isLast = attempt === policy.maxAttempts;
      emit?.({ kind: 'retry.attempt_failed', attempt, error, willRetry: !isLast });
      if (isLast) {
        emit?.({
          kind: 'retry.gave_up',
          attempts: attempt,
          reason: 'attempts_exhausted',
          error,
        });
        throw error;
      }
    }

    const delayMs = backoffDelay(policy, attempt);
    // A backoff that would outlast the deadline leaves no room for the next
    // attempt, so it fails now rather than sleeping to no purpose.
    if (delayMs >= remaining()) {
      throw deadlineExceeded(attempt, lastError);
    }
    emit?.({ kind: 'retry.backoff', attempt, delayMs });
    await delay(clock, delayMs);
  }

  /* c8 ignore next -- unreachable: the loop returns or throws on every path */
  throw lastError;
}

/** Full-jitter delay to apply after a failed `attempt` (1-based). */
function backoffDelay(policy: RetryPolicy, attempt: number): number {
  const { backoff } = policy;
  if (backoff.kind === 'fixed') {
    return backoff.delayMs;
  }
  const rng = policy.rng ?? Math.random;
  const ceiling = Math.min(
    backoff.maxDelayMs,
    backoff.baseMs * 2 ** (attempt - 1),
  );
  return rng() * ceiling;
}

/**
 * Runs one attempt under `budgetMs`. On expiry the attempt's signal is aborted
 * with the error from `expired` and the returned promise rejects with it, even
 * if `fn` ignores the signal. The timer is cleared on every settle path.
 */
function runAttempt<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  attempt: number,
  budgetMs: number,
  expired: () => Error,
  clock: Clock,
): Promise<T> {
  const controller = new AbortController();
  if (!Number.isFinite(budgetMs)) {
    return fn(attempt, controller.signal);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cancelTimer = clock.setTimer(Math.max(0, budgetMs), () => {
      if (settled) return;
      settled = true;
      const error = expired();
      controller.abort(error);
      reject(error);
    });

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      cancelTimer();
      finish();
    };

    let attemptPromise: Promise<T>;
    try {
      attemptPromise = fn(attempt, controller.signal);
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    attemptPromise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}
