import { systemClock, sleep } from './clock.js';
import { DeadlineError, TimeoutError } from './errors.js';
/** Backoff delay before the retry that follows `attempt` (1-based). */
export function backoffDelay(backoff, attempt, rng) {
    if (backoff.kind === 'fixed')
        return backoff.delayMs;
    const exp = backoff.baseMs * 2 ** (attempt - 1);
    return rng() * Math.min(backoff.maxDelayMs, exp);
}
export async function withRetry(fn, policy) {
    const clock = policy.clock ?? systemClock;
    const rng = policy.rng ?? Math.random;
    const retryOn = policy.retryOn ?? (() => true);
    const emit = policy.onEvent ?? (() => { });
    const start = clock.now();
    const deadlineAt = policy.totalDeadlineMs === undefined ? undefined : start + policy.totalDeadlineMs;
    let lastError;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        emit({ type: 'attempt-start', attempt, at: clock.now() });
        try {
            const value = await runAttempt(fn, attempt, clock, policy.attemptTimeoutMs, deadlineAt);
            emit({ type: 'attempt-success', attempt, at: clock.now() });
            return value;
        }
        catch (error) {
            lastError = error;
            const retryable = retryOn(error);
            const attemptsLeft = attempt < policy.maxAttempts;
            emit({
                type: 'attempt-failure',
                attempt,
                at: clock.now(),
                error,
                willRetry: retryable && attemptsLeft,
            });
            if (!retryable) {
                emit({ type: 'retry-giveup', attempt, at: clock.now(), reason: 'not-retryable' });
                throw error;
            }
            if (!attemptsLeft) {
                emit({ type: 'retry-giveup', attempt, at: clock.now(), reason: 'attempts' });
                throw error;
            }
            const delayMs = backoffDelay(policy.backoff, attempt, rng);
            const now = clock.now();
            if (deadlineAt !== undefined && now + delayMs >= deadlineAt) {
                emit({ type: 'retry-giveup', attempt, at: now, reason: 'deadline' });
                throw new DeadlineError(`total deadline of ${String(policy.totalDeadlineMs)}ms expired during backoff after attempt ${attempt}`, { cause: error });
            }
            emit({ type: 'backoff', attempt, at: now, delayMs });
            await sleep(clock, delayMs);
        }
    }
    /* istanbul ignore next — loop above always returns or throws when maxAttempts >= 1 */
    throw new DeadlineError('retry loop exhausted without an attempt', { cause: lastError });
}
/** Runs one attempt under a timeout that is also clipped by the total deadline. */
async function runAttempt(fn, attempt, clock, attemptTimeoutMs, deadlineAt) {
    const budgets = [];
    if (attemptTimeoutMs !== undefined)
        budgets.push(attemptTimeoutMs);
    if (deadlineAt !== undefined)
        budgets.push(deadlineAt - clock.now());
    const timeoutMs = budgets.length === 0 ? undefined : Math.min(...budgets);
    const controller = new AbortController();
    if (timeoutMs === undefined) {
        return await fn(attempt, controller.signal);
    }
    let cancelTimer;
    const expired = new Promise((_resolve, reject) => {
        cancelTimer = clock.setTimer(Math.max(0, timeoutMs), () => {
            const err = new TimeoutError(attempt, timeoutMs);
            controller.abort(err);
            reject(err);
        });
    });
    // Keep an unhandled-rejection guard on the loser of the race.
    expired.catch(() => { });
    try {
        return await Promise.race([fn(attempt, controller.signal), expired]);
    }
    finally {
        cancelTimer?.();
    }
}
//# sourceMappingURL=retry.js.map