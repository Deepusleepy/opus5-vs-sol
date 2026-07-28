# T6 — Node.js: backpressure-correct log pipeline

Build a Node.js (ESM, no external dependencies) streaming log processor and prove its memory behavior.

Spec:
- CLI `node process-logs.mjs <input> <output>` reading newline-delimited JSON log lines: `{"ts": <epoch-ms>, "level": "debug|info|warn|error", "msg": string, "reqId"?: string}`.
- Transformations, all in one streaming pass: drop `debug` lines; redact any substring matching `Bearer [A-Za-z0-9._-]+` in `msg` to `Bearer [REDACTED]`; for lines sharing the same `reqId`, add `"seq": <1-based counter per reqId>`; malformed JSON lines go to `<output>.rejects` with line numbers, without crashing the pipeline.
- MUST handle multi-gigabyte inputs in bounded memory: correct backpressure through the whole pipeline (no `data` events with unbounded buffering, no accumulating arrays of lines, reqId counters may grow but nothing else). Lines can be split across chunk boundaries and a single line can exceed one chunk.
- Handle CRLF and missing trailing newline. Output must preserve input order.
- Provide `make-fixture.mjs` that generates a configurable-size fixture (default 200MB, allow 50MB for the test run) with seeded randomness, including adversarial lines: huge single line (>8MB), split-token edge (Bearer token split across chunk boundary is NOT possible from the file API — but token at end of a line at a chunk boundary is; cover it), malformed lines, CRLF mix.
- Test script `test.mjs` (node:test) that: runs the pipeline on a 50MB fixture while sampling `process.memoryUsage().rss` and asserts peak RSS stays under 150MB above baseline; verifies redaction, seq counters, reject handling, order; and a unit test of the line-splitting transform with pathological chunkings (1-byte chunks).

Deliverables in this directory only; all tests green (`node --test`), output tails in SUMMARY.md. `SUMMARY.md` as in T1. No AI model names anywhere. Simplicity counts.
