# T6 — Backpressure-correct NDJSON log pipeline

## What I built

Three files, ESM, Node standard library only.

- **`process-logs.mjs`** — `node process-logs.mjs <input> <output>`. A four-stage
  pipeline: `createReadStream` → `LineSplitter` → `LogProcessor` → `createWriteStream`,
  joined by `stream/promises.pipeline` so backpressure and error propagation are the
  stream machinery's job, not hand-rolled.
  - `LineSplitter` (exported, unit-tested in isolation) is a byte-level `Transform`:
    it scans each `Buffer` for `0x0a`, emits one string per line, strips a trailing
    `\r`, and carries an unterminated remainder as an array of subarrays that is
    `Buffer.concat`ed only when the line finally ends. A line spanning N chunks
    therefore costs one copy of the line, not N.
  - `LogProcessor` handles one line at a time: `debug` dropped, `Bearer [A-Za-z0-9._-]+`
    → `Bearer [REDACTED]` (all occurrences), `seq` added per `reqId`, malformed JSON
    (and non-object JSON) written to `<output>.rejects` as `<1-based line no>: <line>`.
    Rejects use `write()`'s return value and wait for `drain` before calling the
    transform callback, so the side channel exerts backpressure too.
  - Exits 1 with a one-line message on I/O errors; a failing rejects stream destroys
    the main pipeline rather than being silently ignored.
- **`make-fixture.mjs`** — `node make-fixture.mjs <output> [sizeMB=200] [seed=1]`.
  Seeded mulberry32 PRNG, so a given seed always yields the identical file. Front-loads
  the adversarial cases (5 malformed lines, 2 lines of >8MB each, 8 lines padded so a
  bearer token lands at a 64KB read-chunk boundary), mixes CRLF into every fifth line,
  and deliberately omits the trailing newline on the last line. The counts are exported
  as `PLAN` so the tests assert exact numbers instead of guessing.
- **`test.mjs`** — `node:test`.

## Memory behavior

Nothing is accumulated across lines except the `reqId → counter` map. Peak resident set
is flat in input size:

| input | wall | max RSS |
|---|---|---|
| 50 MB | 0.29 s | 208 MB |
| 1 GB | 6.49 s | 219 MB |

(`/usr/bin/time -l`, whole-process RSS including the ~170MB Node baseline.) The 11MB
delta between a 50MB and a 1GB input is the meaningful number; the in-test assertion is
peak RSS < 150MB **above baseline**, and the observed growth is ~62MB — dominated by the
two 9MB adversarial lines, which must be resident by definition.

## How to verify

```
node --test                                  # all 7 tests
node make-fixture.mjs fixture.ndjson 200     # 200MB default
node process-logs.mjs fixture.ndjson out.ndjson
```

## Test output

```
✔ LineSplitter: CRLF, LF and missing trailing newline (3.559458ms)
✔ LineSplitter: 1-byte chunks give the same result as one chunk (0.709958ms)
✔ LineSplitter: CR and LF arriving in separate chunks (0.301334ms)
✔ LineSplitter: multi-byte UTF-8 split across chunks (0.263375ms)
✔ LineSplitter: a single line far larger than any chunk (2.967667ms)
✔ transformations: redaction, seq, debug drop, rejects, order (2.142ms)
input 50.0MB  lines 242577  written 182184  dropped 60388  rejected 5
rss baseline 174.6MB  peak 236.6MB  growth 62.0MB
✔ 50MB fixture: bounded RSS and correct output (717.4205ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
ℹ duration_ms 800.468833
```

The 50MB test verifies redaction (asserting no `Bearer` survives unredacted anywhere),
per-`reqId` seq continuity, debug removal, exact reject line numbers, monotonic `ts`
ordering, and that both >8MB lines came through intact — all by streaming the output
back through `readline`, so the checker is bounded too.

## Known limitations

- The reject file records the raw line, so a huge malformed line is copied verbatim.
  Bounded per line, not truncated.
- `reqId` counters are unbounded by design (the spec allows this). An input with
  hundreds of millions of distinct `reqId`s would grow the map; a real deployment would
  need a windowing or sharding policy.
- Redaction is regex-based on the decoded `msg` string only. Tokens hidden in other
  fields, or split by whitespace/encoding, are not caught.
- Lines are decoded as UTF-8; invalid byte sequences become replacement characters
  rather than being rejected.
- Blank lines are skipped rather than rejected, on the grounds that a trailing blank is
  a formatting artifact and not a malformed record.
