/**
 * Compile-time exhaustiveness helper: passing a non-`never` value is a type
 * error, so a `switch` that forgets a variant fails `tsc`.
 */
export function assertNever(value, message = 'unhandled variant') {
    throw new Error(`${message}: ${JSON.stringify(value)}`);
}
//# sourceMappingURL=events.js.map