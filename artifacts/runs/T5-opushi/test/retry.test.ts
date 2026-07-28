import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeadlineError, TimeoutError } from '../src/errors.js';
import type { RetryEvent } from '../src/events.js';
import { type RetryPolicy, withRetry } from '../src/retry.js';
import { deferred, FakeClock, flushMicrotasks } from './fake-clock.js';

const alwaysRetry = (): boolean => true;

/** A policy with no time budgets and no backoff, on the given clock. */
function basePolicy(clock: FakeClock): RetryPolicy {
  return {
    maxAttempts: 3,
    backoff: { kind: 'fixed', delayMs: 0 },
    retryOn: alwaysRetry,
    clock,
  };
}

/** Captures the promise's settlement without an unhandled-rejection warning. */
function settled<T>(promise: Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; error: unknown }
> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe('withRetry', () => {
  it('returns the first successful value without retrying', async () => {
    const clock = new FakeClock();
    const calls: number[] = [];

    const value = await withRetry(async (attempt) => {
      calls.push(attempt);
      return 'ok';
    }, basePolicy(clock));

    assert.equal(value, 'ok');
    assert.deepEqual(calls, [1]);
    assert.equal(clock.pendingTimers, 0);
  });

  it('retries until an attempt succeeds', async () => {
    const clock = new FakeClock();
    const seen: number[] = [];

    const result = settled(
      withRetry(async (attempt) => {
        seen.push(attempt);
        if (attempt < 3) throw new Error(`boom ${attempt}`);
        return attempt;
      }, basePolicy(clock)),
    );

    await clock.advance(0);
    assert.deepEqual(await result, { ok: true, value: 3 });
    assert.deepEqual(seen, [1, 2, 3]);
  });

  it('gives up with the last error once attempts are exhausted', async () => {
    const clock = new FakeClock();
    const attempts: number[] = [];

    const result = settled(
      withRetry(async (attempt) => {
        attempts.push(attempt);
        throw new Error(`fail ${attempt}`);
      }, basePolicy(clock)),
    );

    await clock.advance(0);
    const outcome = await result;
    assert.equal(outcome.ok, false);
    assert.match(String(outcome.error), /fail 3/);
    assert.deepEqual(attempts, [1, 2, 3]);
  });

  it('does not retry when retryOn rejects the error', async () => {
    const clock = new FakeClock();
    let calls = 0;

    const result = await settled(
      withRetry(
        async () => {
          calls++;
          throw new Error('fatal');
        },
        { ...basePolicy(clock), retryOn: (e) => !/fatal/.test(String(e)) },
      ),
    );

    assert.equal(result.ok, false);
    assert.match(String(result.error), /fatal/);
    assert.equal(calls, 1);
  });

  it('rejects a maxAttempts below 1', async () => {
    const clock = new FakeClock();
    await assert.rejects(
      withRetry(async () => 1, { ...basePolicy(clock), maxAttempts: 0 }),
      RangeError,
    );
  });

  describe('per-attempt timeout', () => {
    it('aborts the in-flight attempt via its signal', async () => {
      const clock = new FakeClock();
      let observed: unknown;

      const result = settled(
        withRetry(
          (_attempt, signal) =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                observed = signal.reason;
                reject(signal.reason);
              });
            }),
          { ...basePolicy(clock), maxAttempts: 1, attemptTimeoutMs: 100 },
        ),
      );

      await flushMicrotasks();
      assert.equal(observed, undefined, 'must not abort before the budget');

      await clock.advance(100);
      const outcome = await result;
      assert.equal(outcome.ok, false);
      assert.ok(outcome.error instanceof TimeoutError);
      assert.equal(outcome.error.timeoutMs, 100);
      assert.equal(observed, outcome.error, 'signal.reason carries the error');
    });

    it('rejects even when the attempt ignores the signal', async () => {
      const clock = new FakeClock();
      const hung = deferred<string>();

      const result = settled(
        withRetry(() => hung.promise, {
          ...basePolicy(clock),
          maxAttempts: 1,
          attemptTimeoutMs: 50,
        }),
      );

      await clock.advance(50);
      const outcome = await result;
      assert.equal(outcome.ok, false);
      assert.ok(outcome.error instanceof TimeoutError);

      // A late resolution of the abandoned attempt must not disturb anything.
      hung.resolve('too late');
      await flushMicrotasks();
    });

    it('times out one attempt and lets the next succeed', async () => {
      const clock = new FakeClock();

      const result = settled(
        withRetry(
          async (attempt, signal) => {
            if (attempt === 1) {
              await new Promise<never>((_r, reject) => {
                signal.addEventListener('abort', () => {
                  reject(signal.reason);
                });
              });
            }
            return attempt;
          },
          { ...basePolicy(clock), attemptTimeoutMs: 100 },
        ),
      );

      await clock.advance(100);
      assert.deepEqual(await result, { ok: true, value: 2 });
      assert.equal(clock.pendingTimers, 0);
    });

    it('clears the attempt timer on success, leaving no pending timers', async () => {
      const clock = new FakeClock();

      const value = await withRetry(async () => 'done', {
        ...basePolicy(clock),
        attemptTimeoutMs: 30_000,
      });

      assert.equal(value, 'done');
      assert.equal(
        clock.pendingTimers,
        0,
        'a leaked timer would keep the event loop alive',
      );
    });

    it('clears the attempt timer when the attempt throws synchronously', async () => {
      const clock = new FakeClock();

      const result = await settled(
        withRetry(
          () => {
            throw new Error('sync throw');
          },
          { ...basePolicy(clock), maxAttempts: 1, attemptTimeoutMs: 30_000 },
        ),
      );

      assert.equal(result.ok, false);
      assert.equal(clock.pendingTimers, 0);
    });

    it('clears every attempt timer across a full retry sequence', async () => {
      const clock = new FakeClock();

      const result = settled(
        withRetry(
          async () => {
            throw new Error('nope');
          },
          {
            ...basePolicy(clock),
            attemptTimeoutMs: 1000,
            backoff: { kind: 'fixed', delayMs: 10 },
          },
        ),
      );

      await clock.advance(100);
      assert.equal((await result).ok, false);
      assert.equal(clock.pendingTimers, 0);
    });
  });

  describe('backoff', () => {
    it('waits the fixed delay between attempts', async () => {
      const clock = new FakeClock();
      const startedAt: number[] = [];

      const result = settled(
        withRetry(
          async (attempt) => {
            startedAt.push(clock.now());
            if (attempt < 3) throw new Error('again');
            return attempt;
          },
          { ...basePolicy(clock), backoff: { kind: 'fixed', delayMs: 250 } },
        ),
      );

      await clock.advance(1000);
      assert.deepEqual(await result, { ok: true, value: 3 });
      assert.deepEqual(startedAt, [0, 250, 500]);
    });

    it('applies full jitter over an exponentially growing ceiling', async () => {
      const clock = new FakeClock();
      const delays: number[] = [];

      const result = settled(
        withRetry(
          async () => {
            throw new Error('again');
          },
          {
            maxAttempts: 5,
            backoff: { kind: 'exponential', baseMs: 100, maxDelayMs: 10_000 },
            retryOn: alwaysRetry,
            clock,
            rng: () => 1, // draw the ceiling so the schedule is exact
            onEvent: (e) => {
              if (e.kind === 'retry.backoff') delays.push(e.delayMs);
            },
          },
        ),
      );

      await clock.advance(10_000);
      assert.equal((await result).ok, false);
      assert.deepEqual(delays, [100, 200, 400, 800]);
    });

    it('scales the delay by the injected rng draw', async () => {
      const clock = new FakeClock();
      const delays: number[] = [];
      const draws = [0, 0.5, 0.25];
      let i = 0;

      const result = settled(
        withRetry(
          async () => {
            throw new Error('again');
          },
          {
            maxAttempts: 4,
            backoff: { kind: 'exponential', baseMs: 100, maxDelayMs: 10_000 },
            retryOn: alwaysRetry,
            clock,
            rng: () => draws[i++] ?? 1,
            onEvent: (e) => {
              if (e.kind === 'retry.backoff') delays.push(e.delayMs);
            },
          },
        ),
      );

      await clock.advance(10_000);
      assert.equal((await result).ok, false);
      // 0 * 100, 0.5 * 200, 0.25 * 400
      assert.deepEqual(delays, [0, 100, 100]);
    });

    it('clamps the exponential ceiling at maxDelayMs', async () => {
      const clock = new FakeClock();
      const delays: number[] = [];

      const result = settled(
        withRetry(
          async () => {
            throw new Error('again');
          },
          {
            maxAttempts: 6,
            backoff: { kind: 'exponential', baseMs: 100, maxDelayMs: 300 },
            retryOn: alwaysRetry,
            clock,
            rng: () => 1,
            onEvent: (e) => {
              if (e.kind === 'retry.backoff') delays.push(e.delayMs);
            },
          },
        ),
      );

      await clock.advance(10_000);
      assert.equal((await result).ok, false);
      assert.deepEqual(delays, [100, 200, 300, 300, 300]);
    });
  });

  describe('total deadline', () => {
    it('rejects with DeadlineError carrying the last error as cause', async () => {
      const clock = new FakeClock();
      const failure = new Error('underlying');

      const result = settled(
        withRetry(
          async () => {
            throw failure;
          },
          {
            maxAttempts: 10,
            backoff: { kind: 'fixed', delayMs: 1000 },
            retryOn: alwaysRetry,
            clock,
            totalDeadlineMs: 1500,
          },
        ),
      );

      await clock.advance(2000);
      const outcome = await result;
      assert.equal(outcome.ok, false);
      assert.ok(outcome.error instanceof DeadlineError);
      assert.equal(outcome.error.cause, failure);
      assert.equal(outcome.error.deadlineMs, 1500);
      // Attempt 1 at t=0, backoff to t=1000, attempt 2 fails, next backoff of
      // 1000ms would overrun the 1500ms deadline.
      assert.equal(outcome.error.attempts, 2);
      assert.equal(clock.pendingTimers, 0);
    });

    it('does not sleep a backoff that would outlast the deadline', async () => {
      const clock = new FakeClock();

      const result = settled(
        withRetry(
          async () => {
            throw new Error('underlying');
          },
          {
            maxAttempts: 10,
            backoff: { kind: 'fixed', delayMs: 5000 },
            retryOn: alwaysRetry,
            clock,
            totalDeadlineMs: 1000,
          },
        ),
      );

      await flushMicrotasks();
      const outcome = await result;
      assert.equal(outcome.ok, false);
      assert.ok(outcome.error instanceof DeadlineError);
      assert.equal(clock.now(), 0, 'failed without waiting out the backoff');
    });

    it('cuts an in-flight attempt short when the deadline is tighter', async () => {
      const clock = new FakeClock();
      let abortReason: unknown;

      const result = settled(
        withRetry(
          (_attempt, signal) =>
            new Promise<never>(() => {
              signal.addEventListener('abort', () => {
                abortReason = signal.reason;
              });
            }),
          {
            maxAttempts: 3,
            backoff: { kind: 'fixed', delayMs: 0 },
            retryOn: alwaysRetry,
            clock,
            attemptTimeoutMs: 10_000,
            totalDeadlineMs: 500,
          },
        ),
      );

      await clock.advance(500);
      const outcome = await result;
      assert.equal(outcome.ok, false);
      assert.ok(outcome.error instanceof DeadlineError);
      assert.ok(abortReason instanceof DeadlineError);
      assert.equal(clock.pendingTimers, 0);
    });

    it('reports a DeadlineError with no cause when nothing has failed yet', async () => {
      const clock = new FakeClock();

      const result = settled(
        withRetry(
          () => new Promise<never>(() => {}),
          {
            maxAttempts: 1,
            backoff: { kind: 'fixed', delayMs: 0 },
            retryOn: alwaysRetry,
            clock,
            totalDeadlineMs: 100,
          },
        ),
      );

      await clock.advance(100);
      const outcome = await result;
      assert.equal(outcome.ok, false);
      assert.ok(outcome.error instanceof DeadlineError);
      assert.equal(outcome.error.cause, undefined);
      assert.equal(outcome.error.attempts, 1);
    });

    it('succeeds inside the deadline without leaking timers', async () => {
      const clock = new FakeClock();

      const result = settled(
        withRetry(
          async (attempt) => {
            if (attempt === 1) throw new Error('once');
            return 'ok';
          },
          {
            maxAttempts: 3,
            backoff: { kind: 'fixed', delayMs: 100 },
            retryOn: alwaysRetry,
            clock,
            attemptTimeoutMs: 1000,
            totalDeadlineMs: 5000,
          },
        ),
      );

      await clock.advance(100);
      assert.deepEqual(await result, { ok: true, value: 'ok' });
      assert.equal(clock.pendingTimers, 0);
    });
  });

  it('emits the full event sequence for a retried-then-succeeded call', async () => {
    const clock = new FakeClock();
    const events: RetryEvent[] = [];

    const result = settled(
      withRetry(
        async (attempt) => {
          if (attempt === 1) throw new Error('first');
          return attempt;
        },
        {
          ...basePolicy(clock),
          backoff: { kind: 'fixed', delayMs: 50 },
          onEvent: (e) => events.push(e),
        },
      ),
    );

    await clock.advance(50);
    assert.deepEqual(await result, { ok: true, value: 2 });
    assert.deepEqual(
      events.map((e) => e.kind),
      ['retry.attempt_failed', 'retry.backoff', 'retry.succeeded'],
    );
  });

  it('emits gave_up with the non_retryable reason', async () => {
    const clock = new FakeClock();
    const events: RetryEvent[] = [];

    await settled(
      withRetry(
        async () => {
          throw new Error('fatal');
        },
        {
          ...basePolicy(clock),
          retryOn: () => false,
          onEvent: (e) => events.push(e),
        },
      ),
    );

    const gaveUp = events.find((e) => e.kind === 'retry.gave_up');
    assert.ok(gaveUp !== undefined && gaveUp.kind === 'retry.gave_up');
    assert.equal(gaveUp.reason, 'non_retryable');
    assert.equal(gaveUp.attempts, 1);
  });

  it('emits gave_up with the attempts_exhausted reason', async () => {
    const clock = new FakeClock();
    const events: RetryEvent[] = [];

    const result = settled(
      withRetry(
        async () => {
          throw new Error('always');
        },
        { ...basePolicy(clock), onEvent: (e) => events.push(e) },
      ),
    );

    await clock.advance(0);
    assert.equal((await result).ok, false);
    const gaveUp = events.find((e) => e.kind === 'retry.gave_up');
    assert.ok(gaveUp !== undefined && gaveUp.kind === 'retry.gave_up');
    assert.equal(gaveUp.reason, 'attempts_exhausted');
    assert.equal(gaveUp.attempts, 3);
  });
});
