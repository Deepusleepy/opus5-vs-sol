export const systemClock = {
    now: () => Date.now(),
    setTimer(delayMs, cb) {
        const handle = setTimeout(cb, delayMs);
        return () => clearTimeout(handle);
    },
};
/** Sleeps on the clock; rejects with `signal.reason` if aborted first. */
export function sleep(clock, delayMs, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            const reason = signal.reason;
            reject(reason);
            return;
        }
        const cancel = clock.setTimer(delayMs, () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        });
        function onAbort() {
            cancel();
            const reason = signal?.reason;
            reject(reason);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
//# sourceMappingURL=clock.js.map