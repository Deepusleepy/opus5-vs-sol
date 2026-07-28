import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertNever, type ResilienceEvent } from '../src/events.js';
import { withRetry } from '../src/retry.js';
import { CircuitBreaker } from '../src/circuit.js';
import { FakeClock } from './fake-clock.js';

/**
 * Exhaustive handler over the whole discriminated union. The `assertNever`
 * call in the default branch is the compile-time proof: if a variant is added
 * to `RetryEvent` or `CircuitEvent` and not handled here, `e` is no longer
 * `never` and `tsc` fails this file.
 */
export function describeEvent(e: ResilienceEvent): string {
  switch (e.type) {
    case 'attempt-start':
      return `start#${String(e.attempt)}`;
    case 'attempt-success':
      return `ok#${String(e.attempt)}`;
    case 'attempt-failure':
      return `fail#${String(e.attempt)}(retry=${String(e.willRetry)})`;
    case 'backoff':
      return `backoff#${String(e.attempt)}+${String(e.delayMs)}ms`;
    case 'retry-giveup':
      return `giveup#${String(e.attempt)}:${e.reason}`;
    case 'circuit-transition':
      return `${e.from}->${e.to}`;
    case 'circuit-rejected':
      return `rejected(${e.state})`;
    case 'circuit-probe':
      return 'probe';
    default:
      return assertNever(e);
  }
}

test('the exhaustive switch handles every variant the library emits', async () => {
  const clock = new FakeClock();
  const seen: string[] = [];
  const onEvent = (e: ResilienceEvent): void => {
    seen.push(describeEvent(e));
  };

  const retry = withRetry(
    async (attempt) => {
      if (attempt < 2) throw new Error('x');
      return attempt;
    },
    { maxAttempts: 3, backoff: { kind: 'fixed', delayMs: 10 }, clock, onEvent },
  );
  retry.catch(() => {});
  await clock.runAll();
  assert.equal(await retry, 2);

  const breaker = new CircuitBreaker(
    async () => {
      throw new Error('down');
    },
    { failureThreshold: 1, cooldownMs: 100, clock, onEvent },
  );
  await assert.rejects(breaker.exec());
  await assert.rejects(breaker.exec());
  await clock.advance(100);
  await assert.rejects(breaker.exec());

  assert.deepEqual(seen, [
    'start#1',
    'fail#1(retry=true)',
    'backoff#1+10ms',
    'start#2',
    'ok#2',
    'closed->open',
    'rejected(open)',
    'open->half-open',
    'probe',
    'half-open->open',
  ]);
});

test('assertNever throws when a bad value reaches it at runtime', () => {
  // The runtime guard behind the compile-time check. The union has no
  // 'nope' member, so this is the one place a cast is used, in test code only.
  const bogus = { type: 'nope' } as unknown as never;
  assert.throws(() => assertNever(bogus), /unhandled variant/);
});

test('giveup reasons are covered by the exhaustive handler', async () => {
  const clock = new FakeClock();
  const seen: string[] = [];
  const run = withRetry(
    async () => {
      throw new Error('always');
    },
    {
      maxAttempts: 2,
      backoff: { kind: 'fixed', delayMs: 5 },
      clock,
      onEvent: (e) => seen.push(describeEvent(e)),
    },
  );
  run.catch(() => {});
  await clock.runAll();
  await assert.rejects(run, /always/);
  assert.ok(seen.includes('giveup#2:attempts'), seen.join(','));
});
