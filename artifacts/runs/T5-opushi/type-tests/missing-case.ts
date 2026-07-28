// NEGATIVE FIXTURE — this file is expected NOT to compile.
//
// It is excluded from tsconfig.json's `include`. `test/events.test.ts` runs
// `tsc --noEmit` against it and asserts a TS2345 error, which is what proves
// the `assertNever` guard in the real switch is load-bearing rather than
// decorative: remove a `case` and the build breaks.
//
// The switch below deliberately omits `circuit.rejected`.

import { assertNever, type ResilienceEvent } from '../src/events.js';

export function describeEventMissingCase(event: ResilienceEvent): string {
  switch (event.kind) {
    case 'retry.attempt_failed':
      return 'attempt failed';
    case 'retry.backoff':
      return 'backing off';
    case 'retry.succeeded':
      return 'succeeded';
    case 'retry.gave_up':
      return 'gave up';
    case 'retry.deadline_exceeded':
      return 'deadline exceeded';
    case 'circuit.opened':
      return 'circuit opened';
    case 'circuit.half_open':
      return 'circuit half-open';
    case 'circuit.closed':
      return 'circuit closed';
    // 'circuit.rejected' is intentionally missing.
    default:
      return assertNever(event);
  }
}
