/**
 * Deterministic clock. Time only moves when the test says so, and
 * `pendingTimers` lets tests assert that nothing was left armed.
 */
export class FakeClock {
    #now;
    #nextId = 1;
    #timers = new Map();
    constructor(startMs = 0) {
        this.#now = startMs;
    }
    now() {
        return this.#now;
    }
    setTimer(delayMs, cb) {
        const id = this.#nextId++;
        this.#timers.set(id, { id, fireAt: this.#now + delayMs, cb });
        return () => {
            this.#timers.delete(id);
        };
    }
    get pendingTimers() {
        return this.#timers.size;
    }
    /**
     * Advances time by `ms`, firing due timers in chronological order and
     * draining the microtask queue after each one so awaiting code can react.
     */
    async advance(ms) {
        await flushMicrotasks();
        const target = this.#now + ms;
        for (;;) {
            const due = [...this.#timers.values()]
                .filter((t) => t.fireAt <= target)
                .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id)[0];
            if (due === undefined)
                break;
            this.#now = Math.max(this.#now, due.fireAt);
            this.#timers.delete(due.id);
            due.cb();
            await flushMicrotasks();
        }
        this.#now = target;
        await flushMicrotasks();
    }
    /** Fires every armed timer, in order, until none remain (bounded). */
    async runAll(limit = 1000) {
        for (let i = 0; i < limit; i++) {
            await flushMicrotasks();
            const next = [...this.#timers.values()].sort((a, b) => a.fireAt - b.fireAt || a.id - b.id)[0];
            if (next === undefined)
                return;
            await this.advance(Math.max(0, next.fireAt - this.#now));
        }
    }
}
export async function flushMicrotasks(rounds = 8) {
    for (let i = 0; i < rounds; i++)
        await Promise.resolve();
}
//# sourceMappingURL=fake-clock.js.map