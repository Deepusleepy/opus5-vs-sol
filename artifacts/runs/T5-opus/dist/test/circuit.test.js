import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/circuit.js';
import { CircuitOpenError } from '../src/errors.js';
import { FakeClock, flushMicrotasks } from './fake-clock.js';
/** A controllable async fn: each call parks until the test settles it. */
function gate() {
    const pending = [];
    const state = {
        calls: 0,
        fn: () => {
            state.calls++;
            return new Promise((resolve, reject) => {
                pending.push({ resolve, reject });
            });
        },
        settle: (outcome) => {
            const next = pending.shift();
            assert.ok(next !== undefined, 'no in-flight call to settle');
            if (outcome.ok)
                next.resolve(outcome.value);
            else
                next.reject(outcome.error);
        },
    };
    return state;
}
test('opens after N consecutive failures and then rejects fast', async () => {
    const clock = new FakeClock();
    const events = [];
    let calls = 0;
    const breaker = new CircuitBreaker(async () => {
        calls++;
        throw new Error('down');
    }, { failureThreshold: 3, cooldownMs: 1000, clock, onEvent: (e) => events.push(e) });
    for (let i = 0; i < 3; i++)
        await assert.rejects(breaker.exec(), /down/);
    assert.equal(breaker.state, 'open');
    await assert.rejects(breaker.exec(), (e) => {
        assert.ok(e instanceof CircuitOpenError);
        assert.equal(e.state, 'open');
        return true;
    });
    assert.equal(calls, 3, 'the open circuit must not invoke the wrapped fn');
    assert.ok(events.some((e) => e.type === 'circuit-transition' && e.from === 'closed' && e.to === 'open'));
});
test('a success resets the consecutive-failure counter', async () => {
    const clock = new FakeClock();
    let shouldFail = true;
    const breaker = new CircuitBreaker(async () => {
        if (shouldFail)
            throw new Error('flaky');
        return 'ok';
    }, { failureThreshold: 3, cooldownMs: 1000, clock });
    await assert.rejects(breaker.exec());
    await assert.rejects(breaker.exec());
    shouldFail = false;
    assert.equal(await breaker.exec(), 'ok');
    shouldFail = true;
    await assert.rejects(breaker.exec());
    await assert.rejects(breaker.exec());
    assert.equal(breaker.state, 'closed', 'counter was reset by the success');
});
test('stays open until the cooldown elapses, then goes half-open', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(async () => {
        throw new Error('down');
    }, { failureThreshold: 1, cooldownMs: 1000, clock });
    await assert.rejects(breaker.exec(), /down/);
    assert.equal(breaker.state, 'open');
    await clock.advance(999);
    assert.equal(breaker.state, 'open');
    await clock.advance(1);
    assert.equal(breaker.state, 'half-open');
});
test('half-open admits exactly ONE probe under concurrency', async () => {
    const clock = new FakeClock();
    const events = [];
    const g = gate();
    const breaker = new CircuitBreaker(g.fn, {
        failureThreshold: 1,
        cooldownMs: 1000,
        clock,
        onEvent: (e) => events.push(e),
    });
    // Trip it.
    const first = breaker.exec();
    const firstAssertion = assert.rejects(first, /down/);
    g.settle({ ok: false, error: new Error('down') });
    await firstAssertion;
    assert.equal(g.calls, 1);
    await clock.advance(1000);
    // Ten simultaneous callers hit the half-open breaker. The probe parks
    // forever (the gate is never settled), so we must not await all of them.
    const outcomes = Array.from({ length: 10 }, () => 'pending');
    const rejections = [];
    for (let i = 0; i < 10; i++) {
        breaker.exec().then(() => {
            outcomes[i] = 'resolved';
        }, (e) => {
            outcomes[i] = 'rejected';
            rejections.push(e);
        });
    }
    await flushMicrotasks();
    // Nine are rejected immediately; the probe is still parked.
    assert.equal(outcomes.filter((o) => o === 'rejected').length, 9, 'only the probe may proceed');
    assert.equal(outcomes.filter((o) => o === 'pending').length, 1, 'exactly one probe in flight');
    assert.equal(rejections.length, 9);
    for (const reason of rejections) {
        assert.ok(reason instanceof CircuitOpenError);
        assert.equal(reason.state, 'half-open');
    }
    assert.equal(g.calls, 2, 'the wrapped fn was called exactly once more (the single probe)');
    assert.equal(events.filter((e) => e.type === 'circuit-probe').length, 1);
});
test('a successful probe closes the circuit', async () => {
    const clock = new FakeClock();
    const g = gate();
    const breaker = new CircuitBreaker(g.fn, { failureThreshold: 1, cooldownMs: 500, clock });
    const trip = assert.rejects(breaker.exec(), /down/);
    g.settle({ ok: false, error: new Error('down') });
    await trip;
    await clock.advance(500);
    assert.equal(breaker.state, 'half-open');
    const probe = breaker.exec();
    g.settle({ ok: true, value: 'recovered' });
    assert.equal(await probe, 'recovered');
    assert.equal(breaker.state, 'closed');
    // And the closed circuit lets traffic through again.
    const after = breaker.exec();
    g.settle({ ok: true, value: 'again' });
    assert.equal(await after, 'again');
});
test('a failed probe re-opens the circuit and restarts the cooldown', async () => {
    const clock = new FakeClock();
    const g = gate();
    const breaker = new CircuitBreaker(g.fn, { failureThreshold: 1, cooldownMs: 500, clock });
    const trip = assert.rejects(breaker.exec(), /down/);
    g.settle({ ok: false, error: new Error('down') });
    await trip;
    await clock.advance(500);
    const probe = assert.rejects(breaker.exec(), /still down/);
    g.settle({ ok: false, error: new Error('still down') });
    await probe;
    assert.equal(breaker.state, 'open');
    await clock.advance(499);
    assert.equal(breaker.state, 'open', 'cooldown restarted from the failed probe');
    await clock.advance(1);
    assert.equal(breaker.state, 'half-open');
});
//# sourceMappingURL=circuit.test.js.map