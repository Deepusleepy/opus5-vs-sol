import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBreaker, CircuitOpenError, DeadlineError, TimeoutError, withRetry, } from "../src/index.js";
class ManualClock {
    #currentTime = 0;
    #nextOrder = 0;
    #timers = [];
    now() {
        return this.#currentTime;
    }
    setTimeout(callback, delayMs) {
        const timer = {
            callback,
            dueAt: this.#currentTime + delayMs,
            order: this.#nextOrder,
            cancelled: false,
        };
        this.#nextOrder += 1;
        this.#timers.push(timer);
        return {
            cancel: () => {
                timer.cancelled = true;
            },
        };
    }
    pendingTimerCount() {
        return this.#timers.filter((timer) => !timer.cancelled).length;
    }
    async advanceBy(milliseconds) {
        const target = this.#currentTime + milliseconds;
        while (true) {
            let next;
            for (const timer of this.#timers) {
                if (timer.cancelled || timer.dueAt > target) {
                    continue;
                }
                if (next === undefined ||
                    timer.dueAt < next.dueAt ||
                    (timer.dueAt === next.dueAt && timer.order < next.order)) {
                    next = timer;
                }
            }
            if (next === undefined) {
                break;
            }
            this.#timers = this.#timers.filter((timer) => timer !== next);
            this.#currentTime = next.dueAt;
            next.callback();
            await flushMicrotasks();
        }
        this.#currentTime = target;
        await flushMicrotasks();
    }
}
class Deferred {
    promise;
    resolve = () => {
        throw new Error("Deferred promise is not initialized");
    };
    reject = () => {
        throw new Error("Deferred promise is not initialized");
    };
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}
async function flushMicrotasks() {
    for (let turn = 0; turn < 6; turn += 1) {
        await Promise.resolve();
    }
}
function eventLabel(event) {
    switch (event.type) {
        case "retry-attempt-started":
            return `start-${event.attempt}`;
        case "retry-attempt-succeeded":
            return `success-${event.attempt}`;
        case "retry-attempt-failed":
            return `failure-${event.attempt}-${event.willRetry}`;
        case "retry-scheduled":
            return `scheduled-${event.afterAttempt}-${event.delayMs}`;
        case "circuit-state-changed":
            return `${event.from}-to-${event.to}`;
        case "circuit-call-rejected":
            return `rejected-${event.state}`;
        default: {
            const exhaustive = event;
            return exhaustive;
        }
    }
}
test("the event union is exhaustively consumable", () => {
    assert.equal(eventLabel({ type: "circuit-call-rejected", state: "half-open" }), "rejected-half-open");
});
test("withRetry cleans up an attempt timeout after success", async () => {
    const clock = new ManualClock();
    let receivedSignal;
    const result = await withRetry(async (_attempt, signal) => {
        receivedSignal = signal;
        return "done";
    }, {
        maxAttempts: 2,
        backoff: { kind: "fixed", delayMs: 5 },
        attemptTimeoutMs: 50,
        retryOn: () => true,
        clock,
    });
    assert.equal(result, "done");
    assert.equal(receivedSignal?.aborted, false);
    assert.equal(clock.pendingTimerCount(), 0);
});
test("withRetry aborts a timed-out attempt and retries", async () => {
    const clock = new ManualClock();
    const events = [];
    let calls = 0;
    let firstAttemptWasAborted = false;
    const resultPromise = withRetry((attempt, signal) => {
        calls += 1;
        if (attempt === 2) {
            return Promise.resolve("recovered");
        }
        return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
                firstAttemptWasAborted = signal.aborted;
                reject(signal.reason);
            }, { once: true });
        });
    }, {
        maxAttempts: 2,
        backoff: { kind: "fixed", delayMs: 5 },
        attemptTimeoutMs: 10,
        retryOn: (error) => error instanceof TimeoutError,
        clock,
        onEvent: (event) => events.push(event),
    });
    await flushMicrotasks();
    assert.equal(clock.pendingTimerCount(), 1);
    await clock.advanceBy(10);
    assert.equal(firstAttemptWasAborted, true);
    assert.equal(calls, 1);
    assert.equal(clock.pendingTimerCount(), 1);
    await clock.advanceBy(5);
    assert.equal(await resultPromise, "recovered");
    assert.equal(calls, 2);
    assert.equal(clock.pendingTimerCount(), 0);
    assert.deepEqual(events.map((event) => event.type), [
        "retry-attempt-started",
        "retry-attempt-failed",
        "retry-scheduled",
        "retry-attempt-started",
        "retry-attempt-succeeded",
    ]);
});
test("withRetry reports the last error as cause when deadline expires in backoff", async () => {
    const clock = new ManualClock();
    const underlying = new Error("temporary failure");
    const resultPromise = withRetry(() => Promise.reject(underlying), {
        maxAttempts: 3,
        backoff: { kind: "fixed", delayMs: 50 },
        totalDeadlineMs: 10,
        retryOn: () => true,
        clock,
    });
    const rejection = assert.rejects(resultPromise, (error) => {
        assert.ok(error instanceof DeadlineError);
        assert.equal(error.cause, underlying);
        return true;
    });
    await flushMicrotasks();
    assert.equal(clock.pendingTimerCount(), 1);
    await clock.advanceBy(9);
    assert.equal(clock.pendingTimerCount(), 1);
    await clock.advanceBy(1);
    await rejection;
    assert.equal(clock.pendingTimerCount(), 0);
});
test("exponential backoff uses full jitter from the injected RNG", async () => {
    const clock = new ManualClock();
    const scheduledDelays = [];
    let attempts = 0;
    const resultPromise = withRetry(() => {
        attempts += 1;
        if (attempts < 3) {
            return Promise.reject(new Error("retry"));
        }
        return Promise.resolve("ok");
    }, {
        maxAttempts: 3,
        backoff: {
            kind: "exponential",
            baseDelayMs: 100,
            maxDelayMs: 1_000,
            rng: () => 0.25,
        },
        retryOn: () => true,
        clock,
        onEvent: (event) => {
            if (event.type === "retry-scheduled") {
                scheduledDelays.push(event.delayMs);
            }
        },
    });
    await flushMicrotasks();
    assert.equal(attempts, 1);
    await clock.advanceBy(24);
    assert.equal(attempts, 1);
    await clock.advanceBy(1);
    assert.equal(attempts, 2);
    await clock.advanceBy(50);
    assert.equal(await resultPromise, "ok");
    assert.equal(attempts, 3);
    assert.deepEqual(scheduledDelays, [25, 50]);
});
test("retryOn can stop retries and preserves the original error", async () => {
    const clock = new ManualClock();
    const fatal = new Error("fatal");
    let attempts = 0;
    await assert.rejects(withRetry(() => {
        attempts += 1;
        return Promise.reject(fatal);
    }, {
        maxAttempts: 4,
        backoff: { kind: "fixed", delayMs: 10 },
        retryOn: () => false,
        clock,
    }), (error) => error === fatal);
    assert.equal(attempts, 1);
    assert.equal(clock.pendingTimerCount(), 0);
});
test("circuit opens after consecutive failures and rejects fast", async () => {
    const clock = new ManualClock();
    const events = [];
    let calls = 0;
    const breaker = new CircuitBreaker(() => {
        calls += 1;
        return Promise.reject(new Error(`failure ${calls}`));
    }, {
        failureThreshold: 2,
        cooldownMs: 100,
        clock,
        onEvent: (event) => events.push(event),
    });
    await assert.rejects(breaker.execute(), /failure 1/);
    assert.equal(breaker.state, "closed");
    await assert.rejects(breaker.execute(), /failure 2/);
    assert.equal(breaker.state, "open");
    await assert.rejects(breaker.execute(), (error) => error instanceof CircuitOpenError && error.state === "open");
    assert.equal(calls, 2);
    assert.deepEqual(events.map((event) => event.type), ["circuit-state-changed", "circuit-call-rejected"]);
});
test("a success resets the closed-state consecutive failure count", async () => {
    const outcomes = ["fail", "success", "fail"];
    let call = 0;
    const breaker = new CircuitBreaker(() => {
        const outcome = outcomes[call];
        call += 1;
        return outcome === "success"
            ? Promise.resolve("ok")
            : Promise.reject(new Error("failure"));
    }, { failureThreshold: 2, cooldownMs: 100 });
    await assert.rejects(breaker.execute(), /failure/);
    assert.equal(await breaker.execute(), "ok");
    await assert.rejects(breaker.execute(), /failure/);
    assert.equal(breaker.state, "closed");
});
test("half-open admits exactly one probe while concurrent calls fail fast", async () => {
    const clock = new ManualClock();
    const probe = new Deferred();
    let calls = 0;
    const breaker = new CircuitBreaker(() => {
        calls += 1;
        if (calls === 1) {
            return Promise.reject(new Error("open it"));
        }
        if (calls === 2) {
            return probe.promise;
        }
        return Promise.resolve("normal call");
    }, { failureThreshold: 1, cooldownMs: 100, clock });
    await assert.rejects(breaker.execute(), /open it/);
    assert.equal(breaker.state, "open");
    await clock.advanceBy(100);
    const probeCall = breaker.execute();
    assert.equal(breaker.state, "half-open");
    await assert.rejects(breaker.execute(), (error) => error instanceof CircuitOpenError && error.state === "half-open");
    assert.equal(calls, 2);
    probe.resolve("probe passed");
    assert.equal(await probeCall, "probe passed");
    assert.equal(breaker.state, "closed");
    assert.equal(await breaker.execute(), "normal call");
    assert.equal(calls, 3);
});
test("a failed half-open probe reopens the circuit and restarts cooldown", async () => {
    const clock = new ManualClock();
    let calls = 0;
    const breaker = new CircuitBreaker(() => {
        calls += 1;
        if (calls <= 2) {
            return Promise.reject(new Error(`failure ${calls}`));
        }
        return Promise.resolve("restored");
    }, { failureThreshold: 1, cooldownMs: 100, clock });
    await assert.rejects(breaker.execute(), /failure 1/);
    await clock.advanceBy(100);
    await assert.rejects(breaker.execute(), /failure 2/);
    assert.equal(breaker.state, "open");
    await clock.advanceBy(99);
    await assert.rejects(breaker.execute(), (error) => error instanceof CircuitOpenError);
    assert.equal(calls, 2);
    await clock.advanceBy(1);
    assert.equal(await breaker.execute(), "restored");
    assert.equal(breaker.state, "closed");
    assert.equal(calls, 3);
});
//# sourceMappingURL=resilience.test.js.map