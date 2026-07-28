import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CircuitBreaker } from '../src/circuit-breaker.js';
import { assertNever, type ResilienceEvent } from '../src/events.js';
import { withRetry } from '../src/retry.js';
import { deferred, FakeClock, flushMicrotasks } from './fake-clock.js';

/** Narrows a thrown `execFileSync` failure to its captured stdout. */
function stdoutOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stdout' in error) {
    const { stdout } = error;
    if (typeof stdout === 'string') return stdout;
    if (Buffer.isBuffer(stdout)) return stdout.toString('utf8');
  }
  return '';
}

/** Walks up from this file to the directory holding package.json. */
function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the project root');
}

/**
 * The exhaustive consumer. Every arm narrows to a single variant and the
 * `default` receives `never`, so adding a variant to `ResilienceEvent` without
 * a matching arm is a `tsc` error rather than a runtime surprise.
 * `type-tests/missing-case.ts` is the fixture that proves it.
 */
function describeEvent(event: ResilienceEvent): string {
  switch (event.kind) {
    case 'retry.attempt_failed':
      return `attempt ${event.attempt} failed (willRetry=${event.willRetry})`;
    case 'retry.backoff':
      return `backing off ${event.delayMs}ms after attempt ${event.attempt}`;
    case 'retry.succeeded':
      return `succeeded on attempt ${event.attempt}`;
    case 'retry.gave_up':
      return `gave up after ${event.attempts} attempts (${event.reason})`;
    case 'retry.deadline_exceeded':
      return `deadline exceeded after ${event.attempts} attempts`;
    case 'circuit.opened':
      return `circuit opened after ${event.consecutiveFailures} failures`;
    case 'circuit.half_open':
      return 'circuit half-open';
    case 'circuit.closed':
      return 'circuit closed';
    case 'circuit.rejected':
      return `circuit rejected (${event.reason}, retry in ${event.retryAfterMs}ms)`;
    default:
      return assertNever(event);
  }
}

describe('event stream', () => {
  it('handles every variant of the union', async () => {
    const clock = new FakeClock();
    const lines: string[] = [];
    const record = (e: ResilienceEvent): void => {
      lines.push(describeEvent(e));
    };

    // Retry: failed attempt, backoff, deadline exceeded.
    await withRetry(
      async () => 'ok',
      {
        maxAttempts: 1,
        backoff: { kind: 'fixed', delayMs: 0 },
        retryOn: () => true,
        clock,
        onEvent: record,
      },
    );

    const deadlineRun = withRetry(
      async () => {
        throw new Error('down');
      },
      {
        maxAttempts: 5,
        backoff: { kind: 'fixed', delayMs: 1000 },
        retryOn: () => true,
        clock,
        totalDeadlineMs: 1500,
        onEvent: record,
      },
    ).catch(() => undefined);
    await clock.advance(2000);
    await deadlineRun;

    await withRetry(
      async () => {
        throw new Error('fatal');
      },
      {
        maxAttempts: 3,
        backoff: { kind: 'fixed', delayMs: 0 },
        retryOn: () => false,
        clock,
        onEvent: record,
      },
    ).catch(() => undefined);

    // Circuit: opened, rejected (both reasons), half_open, closed.
    const probe = deferred<string>();
    let settleNext: 'fail' | 'ok' = 'fail';
    const breaker = new CircuitBreaker(
      async () => {
        if (settleNext === 'fail') throw new Error('down');
        return probe.promise;
      },
      { failureThreshold: 1, cooldownMs: 100, clock, onEvent: record },
    );

    await breaker.execute().catch(() => undefined); // opens
    await breaker.execute().catch(() => undefined); // rejected: open
    await clock.advance(100);
    settleNext = 'ok';
    const burst = Promise.allSettled([breaker.execute(), breaker.execute()]);
    await flushMicrotasks(); // second caller rejected: probe_in_flight
    probe.resolve('value');
    await burst; // closed

    const kinds = new Set(lines.map((l) => l.split(' ')[0]));
    assert.ok(kinds.size > 0);

    const expected = [
      'succeeded on attempt 1',
      'attempt 1 failed (willRetry=true)',
      'backing off 1000ms after attempt 1',
      'deadline exceeded after 2 attempts',
      'attempt 1 failed (willRetry=false)',
      'gave up after 1 attempts (non_retryable)',
      'circuit opened after 1 failures',
      'circuit rejected (open, retry in 100ms)',
      'circuit half-open',
      'circuit rejected (probe_in_flight, retry in 0ms)',
      'circuit closed',
    ];
    for (const line of expected) {
      assert.ok(lines.includes(line), `missing event line: ${line}`);
    }
  });

  it('assertNever throws if an unexpected variant reaches it at runtime', () => {
    // The only place a cast is needed: simulating a variant the compiler has
    // already proven cannot occur, to check the runtime guard is not silent.
    const rogue = { kind: 'unknown.variant' } as unknown as ResilienceEvent;
    assert.throws(() => describeEvent(rogue), /unhandled variant/);
  });

  it('a non-exhaustive switch fails to compile', () => {
    const root = projectRoot();
    const tsc = join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
    const fixtureProject = join(root, 'type-tests', 'tsconfig.json');
    assert.ok(existsSync(fixtureProject), 'the negative fixture must exist');

    let output: string | undefined;
    try {
      execFileSync(process.execPath, [tsc, '-p', fixtureProject], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      output = stdoutOf(error);
    }

    assert.ok(
      output !== undefined,
      'the fixture compiled, so the exhaustiveness check is inert',
    );
    assert.match(output, /missing-case\.ts/);
    assert.match(
      output,
      /error TS2345/,
      'the unhandled variant must fail to assign to `never`',
    );
    // And it points at the one case that was removed.
    assert.match(output, /circuit\.rejected/);
  });
});
