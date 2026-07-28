import assert from "node:assert/strict";
import test from "node:test";
import {
  AttemptTimeoutError,
  CircuitBreaker,
  CircuitOpenError,
  DeadlineError,
  formatEvent,
  withRetry,
  type Clock,
  type ResilienceEvent,
  type RetryPolicy,
  type TimerHandle,
} from "../src/index.js";

interface ScheduledTimer {
  readonly handle: object;
  readonly due: number;
  readonly callback: () => void;
}

class FakeClock implements Clock {
  private time = 0;
  private timers: ScheduledTimer[] = [];

  public now(): number {
    return this.time;
  }

  public setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const handle = {};
    this.timers.push({ handle, due: this.time + delayMs, callback });
    return handle;
  }

  public clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((timer) => timer.handle !== handle);
  }

  public advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      let next: ScheduledTimer | undefined;
      for (const timer of this.timers) {
        if (timer.due <= target && (next === undefined || timer.due < next.due)) {
          next = timer;
        }
      }
      if (next === undefined) {
        break;
      }
      this.time = next.due;
      this.clearTimeout(next.handle);
      next.callback();
    }
    this.time = target;
  }

  public get activeTimers(): number {
    return this.timers.length;
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

function retryPolicy(clock: Clock): RetryPolicy {
  return {
    maxAttempts: 3,
    backoff: { type: "fixed", delayMs: 10 },
    perAttemptTimeoutMs: 25,
    totalDeadlineMs: 100,
    retryOn: (_error: unknown) => true,
    clock,
  };
}

test("withRetry retries failures and reports typed events", async () => {
  const clock = new FakeClock();
  const events: ResilienceEvent[] = [];
  let calls = 0;
  const resultPromise = withRetry(
    async (attempt) => {
      calls += 1;
      if (attempt < 3) {
        throw new Error(`failure ${attempt}`);
      }
      return "ok";
    },
    { ...retryPolicy(clock), onEvent: (event) => events.push(event) },
  );

  await flushMicrotasks();
  clock.advance(10);
  await flushMicrotasks();
  clock.advance(10);
  await flushMicrotasks();

  assert.equal(await resultPromise, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "retry-attempt-start",
      "retry-attempt-failure",
      "retry-scheduled",
      "retry-attempt-start",
      "retry-attempt-failure",
      "retry-scheduled",
      "retry-attempt-start",
      "retry-success",
    ],
  );
  assert.equal(clock.activeTimers, 0);
});

test("exponential backoff uses full jitter from the injected RNG", async () => {
  const clock = new FakeClock();
  const delays: number[] = [];
  let calls = 0;
  const resultPromise = withRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("retry me");
      }
      return calls;
    },
    {
      ...retryPolicy(clock),
      backoff: { type: "exponential", baseDelayMs: 100, rng: () => 0.4 },
      totalDeadlineMs: 500,
      onEvent: (event) => {
        if (event.type === "retry-scheduled") {
          delays.push(event.delayMs);
        }
      },
    },
  );

  await flushMicrotasks();
  assert.deepEqual(delays, [40]);
  clock.advance(39);
  await flushMicrotasks();
  assert.equal(calls, 1);
  clock.advance(1);
  await flushMicrotasks();
  assert.equal(await resultPromise, 2);
});

test("attempt timeout aborts the operation and leaves no fake timers", async () => {
  const clock = new FakeClock();
  let observedAbort = false;
  const resultPromise = withRetry(
    (_attempt, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = signal.aborted;
          reject(signal.reason);
        });
      }),
    { ...retryPolicy(clock), maxAttempts: 1 },
  );

  await flushMicrotasks();
  assert.equal(clock.activeTimers, 1);
  clock.advance(25);
  await assert.rejects(resultPromise, AttemptTimeoutError);
  assert.equal(observedAbort, true);
  assert.equal(clock.activeTimers, 0);
});

test("deadline expiring during backoff preserves the last error as cause", async () => {
  const clock = new FakeClock();
  const underlying = new Error("underlying");
  const resultPromise = withRetry(
    async () => {
      throw underlying;
    },
    {
      ...retryPolicy(clock),
      backoff: { type: "fixed", delayMs: 100 },
      totalDeadlineMs: 50,
    },
  );

  await flushMicrotasks();
  clock.advance(49);
  await flushMicrotasks();
  clock.advance(1);
  await assert.rejects(resultPromise, (error: unknown) => {
    if (!(error instanceof DeadlineError)) {
      return false;
    }
    assert.equal(error.cause, underlying);
    return true;
  });
});

test("successful attempt clears the platform timeout", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let aborts = 0;
  const result = await withRetry(
    async (_attempt, signal) => {
      signal.addEventListener("abort", () => {
        aborts += 1;
      });
      return 7;
    },
    {
      maxAttempts: 1,
      backoff: { type: "fixed", delayMs: 1 },
      perAttemptTimeoutMs: 1_000,
      totalDeadlineMs: 2_000,
      retryOn: () => true,
    },
  );

  assert.equal(result, 7);
  context.mock.timers.runAll();
  assert.equal(aborts, 0, "a leaked timeout would abort after mock timers run");
});

test("circuit opens after consecutive failures and rejects fast", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const breaker = new CircuitBreaker(
    async () => {
      calls += 1;
      throw new Error("down");
    },
    { failureThreshold: 2, cooldownMs: 100, clock },
  );

  await assert.rejects(breaker.execute(), /down/);
  assert.equal(breaker.state, "closed");
  await assert.rejects(breaker.execute(), /down/);
  assert.equal(breaker.state, "open");
  await assert.rejects(breaker.execute(), CircuitOpenError);
  assert.equal(calls, 2);
});

test("half-open permits exactly one concurrent probe and success closes", async () => {
  const clock = new FakeClock();
  let calls = 0;
  let finishProbe: (() => void) | undefined;
  const breaker = new CircuitBreaker(
    () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("initial failure"));
      }
      return new Promise<string>((resolve) => {
        finishProbe = () => resolve("recovered");
      });
    },
    { failureThreshold: 1, cooldownMs: 50, clock },
  );

  await assert.rejects(breaker.execute(), /initial failure/);
  clock.advance(50);
  const probe = breaker.execute();
  assert.equal(breaker.state, "half-open");
  await assert.rejects(breaker.execute(), (error: unknown) => {
    if (!(error instanceof CircuitOpenError)) {
      return false;
    }
    assert.equal(error.state, "half-open");
    return true;
  });
  assert.equal(calls, 2);
  if (finishProbe === undefined) {
    throw new Error("probe resolver was not installed");
  }
  finishProbe();
  assert.equal(await probe, "recovered");
  assert.equal(breaker.state, "closed");
});

test("failed half-open probe reopens the circuit for a fresh cooldown", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const breaker = new CircuitBreaker(
    async () => {
      calls += 1;
      throw new Error(`failure ${calls}`);
    },
    { failureThreshold: 1, cooldownMs: 10, clock },
  );

  await assert.rejects(breaker.execute());
  clock.advance(10);
  await assert.rejects(breaker.execute());
  assert.equal(breaker.state, "open");
  await assert.rejects(breaker.execute(), CircuitOpenError);
  clock.advance(10);
  await assert.rejects(breaker.execute(), /failure 3/);
  assert.equal(calls, 3);
});

test("the unified event union is consumable through exhaustive formatting", () => {
  const event: ResilienceEvent = {
    type: "circuit-state-change",
    from: "open",
    to: "half-open",
  };
  assert.equal(formatEvent(event), "circuit open -> half-open");
});
