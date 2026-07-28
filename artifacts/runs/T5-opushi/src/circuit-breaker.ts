import { type Clock, systemClock } from './clock.js';
import { CircuitOpenError } from './errors.js';
import type { CircuitEvent } from './events.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip a closed circuit open. Must be >= 1. */
  readonly failureThreshold: number;
  /** How long an open circuit refuses calls before admitting one probe. */
  readonly cooldownMs: number;
  /** Defaults to {@link systemClock}. */
  readonly clock?: Clock;
  readonly onEvent?: (event: CircuitEvent) => void;
}

/**
 * Trips open after `failureThreshold` consecutive failures and rejects calls
 * for `cooldownMs`. It then admits exactly one probe: a success closes the
 * circuit, a failure re-opens it for another cooldown.
 *
 * Concurrent callers cannot all probe. The state transition and the probe
 * claim happen synchronously before `fn` is invoked, so a second caller
 * arriving while the probe is in flight is rejected with
 * `CircuitOpenError { reason: 'probe_in_flight' }`.
 *
 * No timers are used: the cooldown is evaluated from the clock when a call
 * arrives, so an idle breaker holds nothing open.
 */
export class CircuitBreaker<T> {
  readonly #fn: () => Promise<T>;
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #clock: Clock;
  readonly #onEvent: ((event: CircuitEvent) => void) | undefined;

  #state: CircuitState = 'closed';
  #consecutiveFailures = 0;
  #openedAt = 0;
  #probeInFlight = false;

  constructor(fn: () => Promise<T>, options: CircuitBreakerOptions) {
    if (
      !Number.isInteger(options.failureThreshold) ||
      options.failureThreshold < 1
    ) {
      throw new RangeError('failureThreshold must be an integer >= 1');
    }
    if (!(options.cooldownMs >= 0)) {
      throw new RangeError('cooldownMs must be >= 0');
    }
    this.#fn = fn;
    this.#failureThreshold = options.failureThreshold;
    this.#cooldownMs = options.cooldownMs;
    this.#clock = options.clock ?? systemClock;
    this.#onEvent = options.onEvent;
  }

  get state(): CircuitState {
    return this.#state;
  }

  /** Consecutive failures since the last success. */
  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  /**
   * Runs the wrapped function unless the circuit refuses the call, in which
   * case the promise rejects with {@link CircuitOpenError} without invoking it.
   */
  async execute(): Promise<T> {
    // Everything up to the `await` runs synchronously with respect to other
    // callers, which is what makes the single-probe guarantee hold.
    const isProbe = this.#admit();
    try {
      const value = await this.#fn();
      this.#onSuccess(isProbe);
      return value;
    } catch (error) {
      this.#onFailure(isProbe);
      throw error;
    }
  }

  /** Throws if the call is refused; returns true if it is the half-open probe. */
  #admit(): boolean {
    if (this.#state === 'open') {
      const retryAfterMs = Math.max(
        0,
        this.#cooldownMs - (this.#clock.now() - this.#openedAt),
      );
      if (retryAfterMs > 0) {
        this.#emitRejected('open', retryAfterMs);
        throw new CircuitOpenError('open', retryAfterMs);
      }
      this.#state = 'half_open';
      this.#probeInFlight = false;
      this.#onEvent?.({ kind: 'circuit.half_open' });
    }

    if (this.#state === 'half_open') {
      if (this.#probeInFlight) {
        this.#emitRejected('probe_in_flight', 0);
        throw new CircuitOpenError('probe_in_flight', 0);
      }
      this.#probeInFlight = true;
      return true;
    }

    return false;
  }

  #onSuccess(isProbe: boolean): void {
    this.#consecutiveFailures = 0;
    if (isProbe) {
      this.#probeInFlight = false;
      this.#state = 'closed';
      this.#onEvent?.({ kind: 'circuit.closed' });
    }
  }

  #onFailure(isProbe: boolean): void {
    this.#consecutiveFailures++;
    if (isProbe) {
      this.#probeInFlight = false;
      this.#trip();
      return;
    }
    if (
      this.#state === 'closed' &&
      this.#consecutiveFailures >= this.#failureThreshold
    ) {
      this.#trip();
    }
  }

  #trip(): void {
    this.#state = 'open';
    this.#openedAt = this.#clock.now();
    this.#onEvent?.({
      kind: 'circuit.opened',
      consecutiveFailures: this.#consecutiveFailures,
    });
  }

  #emitRejected(
    reason: 'open' | 'probe_in_flight',
    retryAfterMs: number,
  ): void {
    this.#onEvent?.({ kind: 'circuit.rejected', reason, retryAfterMs });
  }
}
