export type RetryEvent =
  | { readonly type: 'attempt-start'; readonly attempt: number; readonly at: number }
  | { readonly type: 'attempt-success'; readonly attempt: number; readonly at: number }
  | {
      readonly type: 'attempt-failure';
      readonly attempt: number;
      readonly at: number;
      readonly error: unknown;
      readonly willRetry: boolean;
    }
  | { readonly type: 'backoff'; readonly attempt: number; readonly at: number; readonly delayMs: number }
  | { readonly type: 'retry-giveup'; readonly attempt: number; readonly at: number; readonly reason: 'attempts' | 'deadline' | 'not-retryable' };

export type CircuitState = 'closed' | 'open' | 'half-open';

export type CircuitEvent =
  | {
      readonly type: 'circuit-transition';
      readonly at: number;
      readonly from: CircuitState;
      readonly to: CircuitState;
    }
  | { readonly type: 'circuit-rejected'; readonly at: number; readonly state: 'open' | 'half-open' }
  | { readonly type: 'circuit-probe'; readonly at: number };

export type ResilienceEvent = RetryEvent | CircuitEvent;

export type EventSink = (e: ResilienceEvent) => void;

/**
 * Compile-time exhaustiveness helper: passing a non-`never` value is a type
 * error, so a `switch` that forgets a variant fails `tsc`.
 */
export function assertNever(value: never, message = 'unhandled variant'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
