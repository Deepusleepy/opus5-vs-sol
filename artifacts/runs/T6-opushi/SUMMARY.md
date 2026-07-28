# T6 — Backpressure-correct log pipeline

Node.js ESM, no dependencies. Developed and verified on Node v24.18.0
(darwin/arm64). Three files: `process-logs.mjs`, `make-fixture.mjs`, `test.mjs`.

## What I built

**`process-logs.mjs`** — `node process-logs.mjs <input> <output>`. The whole
pipeline is one `stream.promises.pipeline` of four stages:

```
createReadStream(input) -> splitLines -> transformLines -> createWriteStream(output)
```

The two middle stages are async generators. That is the whole backpressure
story: `pipeline` drives an async generator by pulling one value at a time, and
a generator suspended at `yield` is not reading its source, so pressure from the
output file propagates back to the read stream automatically. There are no
`data` handlers, no `push`/`highWaterMark` bookkeeping, and no array of lines
anywhere.

- `splitLines(source)` — scans each `Buffer` for `0x0A` with `indexOf` and
  yields one string per line. Only the bytes of the line *currently being
  assembled* are retained (`pending` + `pendingLen`), so a line larger than a
  chunk works and a completed line is released immediately. Decoding happens per
  assembled line, never per chunk — that is what makes a multi-byte UTF-8
  character split across a chunk boundary come back intact. A trailing `\r` is
  stripped after the split, which handles CRLF, LF, and mixed endings uniformly;
  a final line with no newline is yielded at end of stream.
- `transformLines(lines, onReject, stats)` — drops `debug`, redacts
  `/Bearer [A-Za-z0-9._-]+/g` to `Bearer [REDACTED]`, and stamps a 1-based
  `seq` per `reqId`. `JSON.parse` failures and objects missing a string
  `level`/`msg` go to `onReject` with a 1-based line number.
- Rejects go to `<output>.rejects` as `{line, reason, raw}` JSON. This is the
  one write not managed by `pipeline`, so it is hand-backpressured:
  `backpressuredWrite` returns a `drain` promise only when `write()` returns
  false, and `transformLines` awaits it. Returning `undefined` on the common
  path avoids allocating a promise per line.

**`make-fixture.mjs`** — `node make-fixture.mjs <output> [sizeMB=200] [seed=1]`.
Seeded mulberry32, so a given seed reproduces the file byte for byte. It also
writes `<output>.manifest.json` recording the expected results (kept, dropped,
rejected, token count, distinct reqIds, max index) *computed as the data is
generated*, which gives the tests an oracle that never runs the pipeline's own
code.

Adversarial content, placed first so it exists even in small fixtures:

| Case | Detail |
|---|---|
| Huge single line | 9 MiB, > 8 MiB requirement, spans ~144 read chunks |
| Boundary, token flush against end of line | 64 KiB read boundary falls between the last token byte and `\n` |
| Boundary right after the newline | boundary exactly at a line start |
| Boundary inside the Bearer token | token itself split across two reads |
| Boundary inside a CRLF pair | `\r` in one chunk, `\n` in the next |
| Malformed | truncated JSON, non-JSON text, `[1,2,3]`, object with no `msg`, empty line |
| CRLF mix | ~30% of bulk lines use `\r\n` |
| No trailing newline | final line deliberately unterminated |

The boundary cases are placed by solving one modular equation for a filler
length, and the manifest records `onChunkBoundary` for each — the test asserts
all four are true, so if the arithmetic ever drifts the suite says so instead of
silently losing the coverage.

## How to verify

```
node --test                                      # 13 tests
node make-fixture.mjs fixture.ndjson 200          # 200MB default
node process-logs.mjs fixture.ndjson out.ndjson
```

### Test output (`node --test`)

```
✔ splitLines: identical output for every chunking, including 1-byte chunks (5.203625ms)
✔ splitLines: 1-byte chunks split every multi-byte character (0.203083ms)
✔ splitLines: CRLF, bare CR, and mixed line endings (0.212708ms)
✔ splitLines: missing trailing newline yields the final line (0.212666ms)
✔ splitLines: a single line far larger than one chunk (0.680708ms)
✔ splitLines: chunk boundary exactly at, before, and after a newline (1.455666ms)
✔ transformations: redaction, seq, drops, rejects, order (3.27775ms)
✔ transformations: redaction leaves non-token text alone (0.83475ms)
✔ rejects are written with backpressure, not buffered without limit (0.432334ms)
✔ empty input produces empty output and empty rejects (0.685709ms)
✔ a missing input file rejects rather than hanging (0.482ms)
✔ 50MB fixture: bounded RSS, correct output, order preserved (1608.280125ms)
ℹ input 50.0MB | baseline RSS 44.0MB | peak RSS 142.0MB | delta 98.0MB (budget 150MB)
✔ the fixture is deterministic for a given seed (40.586083ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1735.20875
```

### CLI on a 50MB fixture

```
$ node make-fixture.mjs in.ndjson 50 3
in.ndjson: 50.0MB, 361129 lines (214397 kept, 143082 debug, 3650 malformed, 108221 CRLF, huge line 9437184 bytes)

$ node process-logs.mjs in.ndjson out.ndjson
read 361129 lines in 0.3s: wrote 214397, dropped 143082 debug, rejected 3650, tracked 4098 reqIds

$ grep -o -E 'Bearer [A-Za-z0-9._-]+' out.ndjson | grep -v '^Bearer \[REDACTED'
(no output — zero unredacted tokens)
```

## Evidence the memory claim is real

The 150MB assertion is a ceiling, not a proof of bounded memory — a budget can
pass by luck. Three additional checks, run outside the suite:

**1. RSS is stable across runs.** Five consecutive runs of the 50MB test:
delta 97.9 / 98.0 / 98.0 / 98.4 / 98.0 MB. The 52MB of headroom is not noise
absorption.

**2. Heap does not grow with input.** Peak `heapUsed` under a hard
`--max-old-space-size=96` cap:

| Input | Peak heapUsed | Lines | reqIds |
|---|---|---|---|
| 50MB | 41.1 MB above baseline | 361,093 | 4,098 |
| 200MB | 35.3 MB above baseline | 1,681,524 | 4,098 |
| 400MB | 41.5 MB above baseline | 3,435,404 | 4,098 |

Flat across an 8x input range. The 400MB file also completes under a
`--max-old-space-size=48` cap. Raw RSS *does* drift upward with input size
(98 → 114 → 145 MB) — that is GC laziness reclaiming at its own pace, not
retention, which is exactly what the flat heap numbers under a hard cap
distinguish. Worth knowing, because a naive reading of RSS alone would suggest
a slow leak.

**3. Every gate was seen failing.** A scratch mutation harness applied 11
defects one at a time and re-ran the suite. **11/11 turned the suite red**,
including both memory-relevant ones:

| Mutation | Killed by |
|---|---|
| No CR strip | CRLF test |
| Drop final unterminated line | trailing-newline test |
| Decode per chunk (breaks multibyte) | 1-byte-chunk tests |
| seq advanced by dropped debug lines | transformation + 50MB test |
| Redaction not global | transformation test |
| seq 0-based | transformation + 50MB test |
| Reject line numbers 0-based | transformation + 50MB test |
| **Rejects written without backpressure** | **rejects-backpressure test** |
| **All lines buffered into an array** | **RSS budget (253.9MB vs 98.1MB)** |
| debug lines not dropped | transformation + 50MB test |
| Malformed lines crash the pipeline | whole file errors out |

The buffer-everything mutation is the one that matters most: it pushed delta
RSS to 253.9MB against the 150MB budget, so the budget genuinely discriminates.

The rejects-backpressure mutation is worth calling out because it initially
**passed** the whole suite — 60MB of malformed input still ran in 58MB of heap,
because a local SSD drains faster than the pipeline fills it, so no end-to-end
test on this machine can distinguish that code path. I added a direct unit test
of `backpressuredWrite` against a blocked sink instead, which asserts the
contract (returns a pending promise once the watermark is exceeded, resolves
only on drain) rather than the symptom. That test fails against the mutant.

## Known limitations

- **`reqId` counters grow without bound**, as the spec allows. ~50 bytes per
  distinct id, so ~50MB at a million distinct ids. If real inputs have unbounded
  reqId cardinality this needs an eviction policy, and eviction would make `seq`
  wrong rather than merely approximate — so it is a spec question, not an
  implementation one.
- **A single line must fit in memory.** Bounded memory here means "proportional
  to the longest line", not constant. A pathological 2GB single line would still
  blow up, and `Buffer.concat` is capped near 4GB regardless. Lines up to at
  least 9MB are tested.
- `level` is not validated against the four documented values — any string other
  than `debug` passes through. Only the fields the transformations depend on are
  checked; `ts` is carried through untouched and never validated.
- Redaction is `Bearer <token>` exactly as specified. It does not catch
  lowercase `bearer`, tokens containing `/` or `+` (base64url is covered, plain
  base64 is not), or secrets under any other label. Tested explicitly so the
  boundary is visible rather than assumed.
- **Rejects ordering is guaranteed but interleaving is not** — the rejects file
  is in strict input-line order, but nothing synchronizes it against the main
  output file's flushes. Only per-file order is meaningful.
- The RSS budget is a machine-dependent number. On a box with very different GC
  behaviour the 150MB figure may need revisiting; the heap-under-cap check is
  the portable version of the same claim.
