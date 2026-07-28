import * as React from "react";

/**
 * Detects whether we are currently inside a React render (a component body, or
 * a `useMemo` / lazy-initializer callback that runs as part of one).
 *
 * How it works: React keeps the active hook dispatcher on a shared internals
 * object. Its value is
 *   - `null` before React has ever rendered on this client,
 *   - a real dispatcher while a component body is executing (each hook is a
 *     distinct function),
 *   - `ContextOnlyDispatcher` at every other time, where every hook slot is the
 *     *same* `throwInvalidHookError` function.
 *
 * So "two different hook slots hold two different functions" is exactly
 * "a component is rendering right now". This holds in both the development and
 * production builds of react-dom (see `ContextOnlyDispatcher` in
 * `react-dom-client.production.js`).
 *
 * This reads a private field, so it is written to fail *open*: if a future React
 * renames or removes the field we report "not rendering" and lose the warning
 * rather than throwing on correct code.
 */

interface Dispatcher {
  readonly useState: unknown;
  readonly useEffect: unknown;
}

interface SharedInternals {
  /** The currently-installed hook dispatcher. */
  H: Dispatcher | null | undefined;
}

const internals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: SharedInternals;
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/**
 * Whether React has installed a dispatcher at least once in this process.
 *
 * Before the first render, `H` is `null` and any call is genuinely external.
 * Afterwards `H` stays non-null forever — with exactly one exception: the
 * development build's `describeNativeComponentFrame` sets `H = null` and calls
 * the component function *again* to harvest a stack trace for an error message.
 * That replay is still an execution of a component body, so a `set` inside it
 * is still a render-phase set; without this flag it would slip through and
 * mutate the store even though the real render threw.
 */
let sawDispatcher = false;

export function isRenderPhase(): boolean {
  const dispatcher = internals?.H;
  if (dispatcher == null) {
    // Only reachable after the first render inside the dev stack-trace replay.
    return sawDispatcher;
  }
  sawDispatcher = true;
  return dispatcher.useState !== dispatcher.useEffect;
}

export function assertNotRendering(method: string): void {
  if (!isRenderPhase()) return;
  throw new Error(
    `[undoable-store] ${method} was called during render. Mutating an external ` +
      `store while React is rendering makes the render impure: other components ` +
      `in the same pass may read the old value (a torn UI), and concurrent React ` +
      `may replay the render. Move the call into an event handler, an effect, or ` +
      `code that runs outside React.`,
  );
}
