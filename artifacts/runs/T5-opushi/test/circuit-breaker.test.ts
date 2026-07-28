import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CircuitBreaker } from '../src/circuit-breaker.js';
import { CircuitOpenError } from '../src/errors.js';
import type { CircuitEvent } from '../src/events.js';
import { type Deferred, deferred, FakeClock, flushMicrotasks } from './fake-clock.js';

/**
 * A wrapped function the test drives call by call. Each invocation is recorded
 * and left pending until the test settles it, which is what makes the
 * concurrency behaviour observable.
 */
class FakeService {
  calls = 0;
  readonly #pending: Deferred<string>[] = [];

  readonly fn = (): Promise<string> => {
    this.calls++;
    const d = deferred<string>();
    this.#pending.push(d);
    return d.promise;
  };

  /** Settles the oldest unsettled call. */
  settle(outcome: 'ok' | 'fail'): void {
    const next = this.#pending.shift();
    assert.ok(next !== undefined, 'no in-flight call to settle');
    if (outcome === 'ok') next.resolve('value');
    else next.reject(new Error('service down'));
  }

  get inFlight(): number {
    return this.#pending.length;
  }
}

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the promise to reject');
}

/** Runs one call that fails, driving the breaker one failure closer to open. */
async function failOnce(
  breaker: CircuitBreaker<string>,
  service: FakeService,
): Promise<unknown> {
  const call = expectRejection(breaker.execute());
  await flushMicrotasks();
  service.settle('fail');
  return call;
}

/** Runs one call that succeeds. */
async function succeedOnce(
  breaker: CircuitBreaker<string>,
  service: FakeService,
): Promise<string> {
  const call = breaker.execute();
  await flushMicrotasks();
  service.settle('ok');
  return call;
}

describe('CircuitBreaker', () => {
  it('stays closed and passes values through while calls succeed', async () => {
    const clock = new FakeClock();
    const service = new FakeService();
    const breaker = new CircuitBreaker(service.fn, {
      failureThreshold: 2,
      cooldownMs: 1000,
      clock,
    });

    assert.equal(await succeedOnce(breaker, service), 'value');
    assert.equal(await succeedOnce(breaker, service), 'value');
    assert.equal(breaker.state, 'closed');
    assert.equal(service.calls, 2);
  });

  it('propagates the underlying error while still closed', async () => {
    const clock = new FakeClock();
    const service = new FakeService();
    const breaker = new CircuitBreaker(service.fn, {
      failureThreshold: 3,
      cooldownMs: 1000,
      clock,
    });

    const error = await failOnce(breaker, service);
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'service down');
    assert.equal(breaker.state, 'closed');
  });

  it('opens after N consecutive failures and then rejects fast', async () => {
    const clock = new FakeClock();
    const service = new FakeService();
    const breaker = new CircuitBreaker(service.fn, {
      failureThreshold: 3,
      cooldownMs: 1000,
      clock,
    });

    await failOnce(breaker, service);
    await failOnce(breaker, service);
    assert.equal(breaker.state, 'closed', 'not yet at the threshold');
    await failOnce(breaker, service);
    assert.equal(breaker.state, 'open');
    assert.equal(service.calls, 3);

    const error = await expectRejection(breaker.execute());
    assert.ok(error instanceof CircuitOpenError);
    assert.equal(error.reason, 'open');
    assert.equal(error.retryAfterMs, 1000);
    assert.equal(service.calls, 3, 'an open circuit must not call the function');
  });

  it('resets the failure run after an interleaved success', async () => {
    const clock = new FakeClock();
    const service = new FakeService();
    const breaker = new CircuitBreaker(service.fn, {
      failureThreshold: 3,
      cooldownMs: 1000,
      clock,
    });

    await failOnce(breaker, service);
    await failOnce(breaker, service);
    await succeedOnce(breaker, service);
    assert.equal(breaker.consecutiveFailures, 0);

    await failOnce(breaker, service);
    await failOnce(breaker, service);
    assert.equal(breaker.state, 'closed', 'the run was broken by the success');
  });

  it('reports a shrinking retryAfterMs as the cooldown elapses', async () => {
    const clock = new FakeClock();
    const service = new FakeService();
    const breaker = new CircuitBreaker(service.fn, {
      failureThreshold: 1,
      cooldownMs: 1000,
      clock,
    });

    await failOnce(breaker, service);
    await clock.advance(600);

    const error = await expectRejection(breaker.execute());
    assert.ok(error instanceof CircuitOpenError);
    assert.equal(error.retryAfterMs, 400);
  });

  describe('half-open', () => {
    /** An open breaker whose cooldown has just elapsed. */
    async function cooledDown(clock: FakeClock): Promise<{
      breaker: CircuitBreaker<string>;
      service: FakeService;
      events: CircuitEvent[];
    }> {
      const service = new FakeService();
      const events: CircuitEvent[] = [];
      const breaker = new CircuitBreaker(service.fn, {
        failureThreshold: 1,
        cooldownMs: 1000,
        clock,
        onEvent: (e) => events.push(e),
      });
      await failOnce(breaker, service);
      assert.equal(breaker.state, 'open');
      await clock.advance(1000);
      return { breaker, service, events };
    }

    it('admits exactly ONE probe when many callers arrive at once', async () => {
      const clock = new FakeClock();
      const { breaker, service } = await cooledDown(clock);
      const callsBefore = service.calls;

      // Ten callers race into a half-open circuit. The probe stays in flight
      // because the service is not settled until after they have all been
      // admitted or refused.
      const outcomes = Promise.allSettled(
        Array.from({ length: 10 }, () => breaker.execute()),
      );
      await flushMicrotasks();

      assert.equal(
        service.calls - callsBefore,
        1,
        'exactly one caller may reach the wrapped function',
      );
      assert.equal(service.inFlight, 1);

      service.settle('ok');
      const results = await outcomes;

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      assert.equal(fulfilled.length, 1, 'only the probe gets a value');

      const refusals = results.filter((r) => r.status === 'rejected');
      assert.equal(refusals.length, 9);
      for (const refusal of refusals) {
        assert.ok(refusal.reason instanceof CircuitOpenError);
        assert.equal(refusal.reason.reason, 'probe_in_flight');
      }

      assert.equal(breaker.state, 'closed', 'the probe succeeded');
    });

    it('refuses concurrent callers even when the probe eventually fails', async () => {
      const clock = new FakeClock();
      const { breaker, service } = await cooledDown(clock);
      const callsBefore = service.calls;

      const outcomes = Promise.allSettled(
        Array.from({ length: 5 }, () => breaker.execute()),
      );
      await flushMicrotasks();
      assert.equal(service.calls - callsBefore, 1);

      service.settle('fail');
      const results = await outcomes;

      assert.equal(results.filter((r) => r.status === 'rejected').length, 5);
      const probeFailures = results.filter(
        (r) =>
          r.status === 'rejected' && !(r.reason instanceof CircuitOpenError),
      );
      assert.equal(probeFailures.length, 1, 'one real call, four refusals');
      assert.equal(breaker.state, 'open', 'the failed probe re-opened it');
    });

    it('emits exactly one half_open event for a burst of callers', async () => {
      const clock = new FakeClock();
      const { breaker, service, events } = await cooledDown(clock);
      events.length = 0;

      const outcomes = Promise.allSettled(
        Array.from({ length: 4 }, () => breaker.execute()),
      );
      await flushMicrotasks();
      service.settle('ok');
      await outcomes;

      const halfOpens = events.filter((e) => e.kind === 'circuit.half_open');
      assert.equal(halfOpens.length, 1);
      assert.equal(
        events.filter(
          (e) => e.kind === 'circuit.rejected' && e.reason === 'probe_in_flight',
        ).length,
        3,
      );
    });

    it('a successful probe closes the circuit and normal service resumes', async () => {
      const clock = new FakeClock();
      const { breaker, service } = await cooledDown(clock);

      assert.equal(await succeedOnce(breaker, service), 'value');
      assert.equal(breaker.state, 'closed');
      assert.equal(breaker.consecutiveFailures, 0);

      assert.equal(await succeedOnce(breaker, service), 'value');
      assert.equal(breaker.state, 'closed');
    });

    it('a failed probe re-opens the circuit for a fresh cooldown', async () => {
      const clock = new FakeClock();
      const { breaker, service } = await cooledDown(clock);
      const callsBefore = service.calls;

      await failOnce(breaker, service);
      assert.equal(service.calls, callsBefore + 1, 'the probe ran');
      assert.equal(breaker.state, 'open');

      const error = await expectRejection(breaker.execute());
      assert.ok(error instanceof CircuitOpenError);
      assert.equal(error.reason, 'open');
      assert.equal(error.retryAfterMs, 1000, 'the cooldown restarted in full');
    });

    it('measures the new cooldown from the probe failure, not the first trip', async () => {
      const clock = new FakeClock();
      const service = new FakeService();
      const breaker = new CircuitBreaker(service.fn, {
        failureThreshold: 1,
        cooldownMs: 1000,
        clock,
      });

      await failOnce(breaker, service);
      await clock.advance(1500); // idle well past the first cooldown
      await failOnce(breaker, service); // the probe fails at t=1500

      await clock.advance(999);
      const error = await expectRejection(breaker.execute());
      assert.ok(error instanceof CircuitOpenError);
      assert.equal(error.retryAfterMs, 1);

      await clock.advance(1);
      assert.equal(await succeedOnce(breaker, service), 'value');
      assert.equal(breaker.state, 'closed');
    });

    it('admits a probe immediately when the cooldown is zero', async () => {
      const clock = new FakeClock();
      const service = new FakeService();
      const breaker = new CircuitBreaker(service.fn, {
        failureThreshold: 1,
        cooldownMs: 0,
        clock,
      });

      await failOnce(breaker, service);
      assert.equal(breaker.state, 'open');
      assert.equal(await succeedOnce(breaker, service), 'value');
      assert.equal(breaker.state, 'closed');
    });
  });

  it('emits the full lifecycle event sequence', async () => {
    const clock = new FakeClock();
    const events: CircuitEvent[] = [];
    const service = new FakeService();
    const breaker = new CircuitBreaker(service.fn, {
      failureThreshold: 2,
      cooldownMs: 1000,
      clock,
      onEvent: (e) => events.push(e),
    });

    await failOnce(breaker, service);
    await failOnce(breaker, service); // opens
    await expectRejection(breaker.execute()); // rejected
    await clock.advance(1000);
    await succeedOnce(breaker, service); // half_open -> closed

    assert.deepEqual(
      events.map((e) => e.kind),
      [
        'circuit.opened',
        'circuit.rejected',
        'circuit.half_open',
        'circuit.closed',
      ],
    );
    const opened = events[0];
    assert.ok(opened !== undefined && opened.kind === 'circuit.opened');
    assert.equal(opened.consecutiveFailures, 2);
  });

  it('rejects invalid options', () => {
    const clock = new FakeClock();
    const noop = async (): Promise<number> => 1;
    assert.throws(
      () =>
        new CircuitBreaker(noop, {
          failureThreshold: 0,
          cooldownMs: 10,
          clock,
        }),
      RangeError,
    );
    assert.throws(
      () =>
        new CircuitBreaker(noop, {
          failureThreshold: 1.5,
          cooldownMs: 10,
          clock,
        }),
      RangeError,
    );
    assert.throws(
      () =>
        new CircuitBreaker(noop, {
          failureThreshold: 1,
          cooldownMs: -1,
          clock,
        }),
      RangeError,
    );
  });

  it('uses no timers, so an idle breaker holds nothing open', async () => {
    const clock = new FakeClock();
    const service = new FakeService();
    const breaker = new CircuitBreaker(service.fn, {
      failureThreshold: 1,
      cooldownMs: 5000,
      clock,
    });

    await failOnce(breaker, service);
    await flushMicrotasks();
    assert.equal(clock.pendingTimers, 0, 'the cooldown is computed, not timed');
  });
});
