import type { CircuitRejectReason } from './errors.js';

/** Why `withRetry` stopped without producing a value. */
export type GiveUpReason =
  /** `retryOn` returned false for the error. */
  | 'non_retryable'
  /** The last allowed attempt failed. */
  | 'attempts_exhausted';

/** Observability events emitted by {@link withRetry}. */
export type RetryEvent =
  | {
      readonly kind: 'retry.attempt_failed';
      readonly attempt: number;
      readonly error: unknown;
      readonly willRetry: boolean;
    }
  | {
      readonly kind: 'retry.backoff';
      readonly attempt: number;
      /** Actual sleep, already clamped to the remaining total deadline. */
      readonly delayMs: number;
    }
  | { readonly kind: 'retry.succeeded'; readonly attempt: number }
  | {
      readonly kind: 'retry.gave_up';
      readonly attempts: number;
      readonly reason: GiveUpReason;
      readonly error: unknown;
    }
  | {
      readonly kind: 'retry.deadline_exceeded';
      readonly attempts: number;
      /** Last underlying error, or undefined if the deadline was already spent. */
      readonly error: unknown;
    };

/** Observability events emitted by {@link CircuitBreaker}. */
export type CircuitEvent =
  | { readonly kind: 'circuit.opened'; readonly consecutiveFailures: number }
  | { readonly kind: 'circuit.half_open' }
  | { readonly kind: 'circuit.closed' }
  | {
      readonly kind: 'circuit.rejected';
      readonly reason: CircuitRejectReason;
      readonly retryAfterMs: number;
    };

/** Every event this library can emit. A single handler can consume both streams. */
export type ResilienceEvent = RetryEvent | CircuitEvent;

/**
 * Compile-time exhaustiveness guard. Passing a value whose type is not `never`
 * is a type error, so any unhandled union member fails `tsc`.
 * See `type-tests/` for a fixture proving the failure.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}
