import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withRetry, backoffDelay } from '../src/retry.js';
import { DeadlineError, TimeoutError } from '../src/errors.js';
import type { ResilienceEvent } from '../src/events.js';
import { FakeClock, flushMicrotasks } from './fake-clock.js';

/** Settled-state probe so tests can assert "still pending". */
function track<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let settled = false;
  const promise = p.finally(() => {
    settled = true;
  });
  promise.catch(() => {});
  return { promise, settled: () => settled };
}

test('succeeds on the first attempt without arming or leaking timers', async () => {
  const clock = new FakeClock();
  const events: ResilienceEvent[] = [];
  const result = await withRetry(async () => 'ok', {
    maxAttempts: 3,
    backoff: { kind: 'fixed', delayMs: 100 },
    attemptTimeoutMs: 1000,
    clock,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result, 'ok');
  assert.equal(clock.pendingTimers, 0, 'attempt timeout timer must be cleared on success');
  assert.deepEqual(
    events.map((e) => e.type),
    ['attempt-start', 'attempt-success'],
  );
});

test('retries with fixed backoff and cleans up every attempt timer', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const run = track(
    withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error(`boom ${String(calls)}`);
        return calls;
      },
      {
        maxAttempts: 5,
        backoff: { kind: 'fixed', delayMs: 100 },
        attemptTimeoutMs: 50,
        clock,
      },
    ),
  );

  await flushMicrotasks();
  assert.equal(calls, 1);
  await clock.advance(100); // first backoff
  assert.equal(calls, 2);
  await clock.advance(100); // second backoff
  assert.equal(await run.promise, 3);
  assert.equal(clock.pendingTimers, 0, 'no timers left after the loop finishes');
});

test('per-attempt timeout aborts the in-flight attempt via the signal', async () => {
  const clock = new FakeClock();
  const abortReasons: unknown[] = [];

  const run = track(
    withRetry(
      async (_attempt, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              abortReasons.push(signal.reason);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      {
        maxAttempts: 1,
        backoff: { kind: 'fixed', delayMs: 0 },
        attemptTimeoutMs: 200,
        clock,
      },
    ),
  );

  await flushMicrotasks();
  assert.equal(run.settled(), false);
  assert.equal(clock.pendingTimers, 1, 'timeout timer is armed while the attempt runs');

  await clock.advance(200);
  await assert.rejects(run.promise, (e: unknown) => {
    assert.ok(e instanceof TimeoutError);
    assert.equal(e.attempt, 1);
    assert.equal(e.timeoutMs, 200);
    return true;
  });
  assert.equal(abortReasons.length, 1);
  assert.ok(abortReasons[0] instanceof TimeoutError);
  assert.equal(clock.pendingTimers, 0);
});

test('exponential backoff with full jitter uses the injected RNG and caps at maxDelayMs', () => {
  const backoff = { kind: 'exponential', baseMs: 100, maxDelayMs: 1000 } as const;
  assert.equal(backoffDelay(backoff, 1, () => 1), 100);
  assert.equal(backoffDelay(backoff, 2, () => 1), 200);
  assert.equal(backoffDelay(backoff, 4, () => 1), 800);
  assert.equal(backoffDelay(backoff, 5, () => 1), 1000, 'capped');
  assert.equal(backoffDelay(backoff, 5, () => 0.25), 250, 'full jitter scales the capped value');
  assert.equal(backoffDelay(backoff, 3, () => 0), 0, 'full jitter can pick zero');
});

test('exponential backoff drives the actual sleep durations', async () => {
  const clock = new FakeClock();
  const delays: number[] = [];
  let calls = 0;
  const run = track(
    withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('nope');
        return 'done';
      },
      {
        maxAttempts: 3,
        backoff: { kind: 'exponential', baseMs: 100, maxDelayMs: 10_000 },
        rng: () => 1,
        clock,
        onEvent: (e) => {
          if (e.type === 'backoff') delays.push(e.delayMs);
        },
      },
    ),
  );

  await clock.runAll();
  assert.equal(await run.promise, 'done');
  assert.deepEqual(delays, [100, 200]);
});

test('retryOn=false rethrows immediately without further attempts', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const fatal = new Error('fatal');
  const reasons: string[] = [];

  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw fatal;
      },
      {
        maxAttempts: 5,
        backoff: { kind: 'fixed', delayMs: 10 },
        retryOn: (e) => !(e instanceof Error && e.message === 'fatal'),
        clock,
        onEvent: (e) => {
          if (e.type === 'retry-giveup') reasons.push(e.reason);
        },
      },
    ),
    (e: unknown) => e === fatal,
  );
  assert.equal(calls, 1);
  assert.deepEqual(reasons, ['not-retryable']);
  assert.equal(clock.pendingTimers, 0);
});

test('exhausting maxAttempts rethrows the last error', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const run = track(
    withRetry(
      async (attempt) => {
        calls++;
        throw new Error(`fail ${String(attempt)}`);
      },
      { maxAttempts: 3, backoff: { kind: 'fixed', delayMs: 10 }, clock },
    ),
  );
  await clock.runAll();
  await assert.rejects(run.promise, /fail 3/);
  assert.equal(calls, 3);
  assert.equal(clock.pendingTimers, 0);
});

test('total deadline expiring mid-backoff rejects with DeadlineError carrying the last error as cause', async () => {
  const clock = new FakeClock();
  const last = new Error('underlying');
  const reasons: string[] = [];

  const run = track(
    withRetry(
      async () => {
        throw last;
      },
      {
        maxAttempts: 10,
        backoff: { kind: 'fixed', delayMs: 400 },
        totalDeadlineMs: 500,
        clock,
        onEvent: (e) => {
          if (e.type === 'retry-giveup') reasons.push(e.reason);
        },
      },
    ),
  );

  await clock.runAll();
  await assert.rejects(run.promise, (e: unknown) => {
    assert.ok(e instanceof DeadlineError);
    assert.equal(e.cause, last);
    return true;
  });
  // attempt 1 fails at t=0, backoff 400 -> t=400 ok; attempt 2 fails at 400,
  // 400 + 400 >= 500 so it gives up during the second backoff.
  assert.deepEqual(reasons, ['deadline']);
  assert.equal(clock.pendingTimers, 0);
});

test('the remaining deadline clips the per-attempt timeout', async () => {
  const clock = new FakeClock();
  const run = track(
    withRetry(async (_a, signal) => new Promise<never>((_r, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason);
      }, { once: true });
    }), {
      maxAttempts: 1,
      backoff: { kind: 'fixed', delayMs: 0 },
      attemptTimeoutMs: 10_000,
      totalDeadlineMs: 300,
      clock,
    }),
  );

  await clock.advance(299);
  assert.equal(run.settled(), false);
  await clock.advance(1);
  await assert.rejects(run.promise, (e: unknown) => {
    assert.ok(e instanceof TimeoutError);
    assert.equal(e.timeoutMs, 300);
    return true;
  });
  assert.equal(clock.pendingTimers, 0);
});

test('a slow attempt that resolves after the timeout does not leak timers or unhandled rejections', async () => {
  const clock = new FakeClock();
  let resolveLate: ((v: string) => void) | undefined;
  const run = track(
    withRetry(async () => new Promise<string>((resolve) => {
      resolveLate = resolve;
    }), {
      maxAttempts: 1,
      backoff: { kind: 'fixed', delayMs: 0 },
      attemptTimeoutMs: 50,
      clock,
    }),
  );

  await clock.advance(50);
  await assert.rejects(run.promise, TimeoutError);
  resolveLate?.('late value');
  await flushMicrotasks();
  assert.equal(clock.pendingTimers, 0);
});
