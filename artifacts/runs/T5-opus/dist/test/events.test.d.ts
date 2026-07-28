import { type ResilienceEvent } from '../src/events.js';
/**
 * Exhaustive handler over the whole discriminated union. The `assertNever`
 * call in the default branch is the compile-time proof: if a variant is added
 * to `RetryEvent` or `CircuitEvent` and not handled here, `e` is no longer
 * `never` and `tsc` fails this file.
 */
export declare function describeEvent(e: ResilienceEvent): string;
