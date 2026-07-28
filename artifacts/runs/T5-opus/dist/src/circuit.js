import { systemClock } from './clock.js';
import { CircuitOpenError } from './errors.js';
/**
 * Circuit breaker around a single async operation.
 *
 * closed --failureThreshold consecutive failures--> open
 * open --cooldownMs elapsed--> half-open (exactly one in-flight probe)
 * half-open --probe ok--> closed | --probe fails--> open
 */
export class CircuitBreaker {
    fn;
    options;
    #state = 'closed';
    #consecutiveFailures = 0;
    #openedAt = 0;
    #probeInFlight = false;
    #clock;
    #emit;
    constructor(fn, options) {
        this.fn = fn;
        this.options = options;
        this.#clock = options.clock ?? systemClock;
        this.#emit = options.onEvent ?? (() => { });
    }
    /** Current state, after applying any due open -> half-open transition. */
    get state() {
        this.#maybeHalfOpen();
        return this.#state;
    }
    async exec() {
        this.#maybeHalfOpen();
        if (this.#state === 'open') {
            this.#emit({ type: 'circuit-rejected', at: this.#clock.now(), state: 'open' });
            throw new CircuitOpenError('open');
        }
        let isProbe = false;
        if (this.#state === 'half-open') {
            // The classic bug: letting every concurrent caller through while
            // half-open. Only the first caller becomes the probe; the rest are
            // rejected fast until the probe settles.
            if (this.#probeInFlight) {
                this.#emit({ type: 'circuit-rejected', at: this.#clock.now(), state: 'half-open' });
                throw new CircuitOpenError('half-open');
            }
            this.#probeInFlight = true;
            isProbe = true;
            this.#emit({ type: 'circuit-probe', at: this.#clock.now() });
        }
        try {
            const value = await this.fn();
            this.#onSuccess(isProbe);
            return value;
        }
        catch (error) {
            this.#onFailure(isProbe);
            throw error;
        }
    }
    #onSuccess(isProbe) {
        if (isProbe)
            this.#probeInFlight = false;
        this.#consecutiveFailures = 0;
        if (this.#state !== 'closed')
            this.#transition('closed');
    }
    #onFailure(isProbe) {
        if (isProbe) {
            this.#probeInFlight = false;
            this.#open();
            return;
        }
        this.#consecutiveFailures++;
        if (this.#state === 'closed' && this.#consecutiveFailures >= this.options.failureThreshold) {
            this.#open();
        }
    }
    #open() {
        this.#openedAt = this.#clock.now();
        this.#consecutiveFailures = 0;
        this.#transition('open');
    }
    #maybeHalfOpen() {
        if (this.#state === 'open' && this.#clock.now() - this.#openedAt >= this.options.cooldownMs) {
            this.#probeInFlight = false;
            this.#transition('half-open');
        }
    }
    #transition(to) {
        const from = this.#state;
        if (from === to)
            return;
        this.#state = to;
        this.#emit({ type: 'circuit-transition', at: this.#clock.now(), from, to });
    }
}
//# sourceMappingURL=circuit.js.map