import { type Clock } from './clock.js';
import type { CircuitState, EventSink } from './events.js';
export interface CircuitBreakerOptions {
    /** Consecutive failures in the closed state that trip the breaker. */
    readonly failureThreshold: number;
    /** How long the breaker stays open before allowing a probe. */
    readonly cooldownMs: number;
    readonly clock?: Clock;
    readonly onEvent?: EventSink;
}
/**
 * Circuit breaker around a single async operation.
 *
 * closed --failureThreshold consecutive failures--> open
 * open --cooldownMs elapsed--> half-open (exactly one in-flight probe)
 * half-open --probe ok--> closed | --probe fails--> open
 */
export declare class CircuitBreaker<T> {
    #private;
    private readonly fn;
    private readonly options;
    constructor(fn: () => Promise<T>, options: CircuitBreakerOptions);
    /** Current state, after applying any due open -> half-open transition. */
    get state(): CircuitState;
    exec(): Promise<T>;
}
