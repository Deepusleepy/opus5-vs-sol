#!/usr/bin/env node
// Generates a deterministic NDJSON log fixture plus a manifest of the exact
// results the pipeline must produce for it.
//
//   node make-fixture.mjs <output> [sizeMB=200] [seed=1]
//
// The manifest (<output>.manifest.json) is computed here, from the data as it
// is generated, so the tests have an oracle that does not go through the
// pipeline's own code.

import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

export const CHUNK = 65536; // fs.createReadStream default highWaterMark
const HUGE_LINE_BYTES = 9 * 1024 * 1024;
const REQ_ID_POOL = 4096;

const WORDS = [
  'cache', 'miss', 'retry', 'upstream', 'latency', 'shard', 'quorum', 'flush',
  'replica', 'timeout', 'handshake', 'commit', 'rollback', 'queue', 'lease',
  'evict', 'compact', 'gossip', 'probe', 'drain',
];

/** mulberry32 — small, seedable, good enough for fixture data. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-';

function token(rand, len = 40) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += TOKEN_CHARS[Math.floor(rand() * TOKEN_CHARS.length)];
  }
  return s;
}

/** Always-nonnegative modulo. */
function mod(a, n) {
  return ((a % n) + n) % n;
}

function words(rand, n) {
  let s = WORDS[Math.floor(rand() * WORDS.length)];
  for (let i = 1; i < n; i++) s += ' ' + WORDS[Math.floor(rand() * WORDS.length)];
  return s;
}

/**
 * A byte-exact writer: tracks the absolute offset of the next byte so the
 * generator can place lines at chosen positions relative to chunk boundaries.
 */
class OffsetWriter {
  constructor(stream) {
    this.stream = stream;
    this.offset = 0;
  }
  // Returns a promise only when the stream asks us to wait.
  write(text) {
    this.offset += Buffer.byteLength(text);
    return this.stream.write(text) ? undefined : once(this.stream, 'drain');
  }
}

export async function makeFixture(outPath, sizeBytes, seed = 1) {
  const rand = rng(seed);
  const stream = createWriteStream(outPath);
  const out = new OffsetWriter(stream);

  const m = {
    seed,
    bytes: 0,
    totalLines: 0,
    rejected: 0, // lines the pipeline must divert to .rejects
    dropped: 0, // debug lines
    kept: 0,
    tokensInKeptLines: 0, // expected "Bearer [REDACTED]" occurrences
    distinctReqIds: 0,
    keptWithReqId: 0,
    maxIndex: 0, // msgs are "#<index> ..." with index strictly increasing
    hugeLineBytes: 0,
    crlfLines: 0,
    boundaryCases: [], // {kind, offset} for the hand-placed adversarial lines
    endsWithNewline: true,
  };
  const seqSeen = new Set();
  let index = 0;

  // Emit one already-serialized line. `eol` is "\n" or "\r\n".
  const emit = async (text, eol) => {
    m.totalLines++;
    if (eol === '\r\n') m.crlfLines++;
    await out.write(text + eol);
  };

  // A normal record. Counts its own effect on the expected output.
  const record = () => {
    index++;
    const r = rand();
    const level = r < 0.4 ? 'debug' : r < 0.75 ? 'info' : r < 0.9 ? 'warn' : 'error';
    const rec = { ts: 1700000000000 + index * 7, level, msg: `#${index} ${words(rand, 4 + Math.floor(rand() * 8))}` };
    let tokens = 0;
    if (rand() < 0.08) {
      // Followed by a space so the greedy match cannot run past the token.
      rec.msg += ` auth Bearer ${token(rand)} ok`;
      tokens = 1;
    }
    if (rand() < 0.6) rec.reqId = `r${Math.floor(rand() * REQ_ID_POOL)}`;

    if (level === 'debug') {
      m.dropped++;
    } else {
      m.kept++;
      m.maxIndex = index;
      m.tokensInKeptLines += tokens;
      if (rec.reqId !== undefined) {
        m.keptWithReqId++;
        seqSeen.add(rec.reqId);
      }
    }
    return JSON.stringify(rec);
  };

  // --- adversarial lines, placed first so they exist even in tiny fixtures ---

  // 1. Lines positioned so that a read-chunk boundary falls at a chosen point
  //    near their end: just before the newline (token flush against the
  //    boundary), exactly after the newline, inside the Bearer token, and
  //    between the CR and LF of a CRLF pair.
  //
  //    The line ends at `out.offset + total`; we want the boundary `splitAt`
  //    bytes before that, i.e. (out.offset + total - splitAt) % CHUNK === 0.
  //    `total` is `base + fillLen + 1` (the filler plus its trailing space), so
  //    fillLen is fixed by one modular equation.
  const boundaryLine = async (kind, splitAt, eol) => {
    index++;
    const tok = token(rand);
    const reqId = `r${index % REQ_ID_POOL}`;
    const build = (fill) =>
      JSON.stringify({
        ts: 1700000000000 + index * 7,
        level: 'warn',
        msg: `#${index} ${fill}auth Bearer ${tok}`,
        reqId,
      });

    const base = Buffer.byteLength(build('')) + eol.length;
    const fillLen = mod(splitAt - base - out.offset - 1, CHUNK);
    const text = build('x'.repeat(fillLen) + ' ');
    const total = Buffer.byteLength(text) + eol.length;
    const boundary = out.offset + total - splitAt;

    m.boundaryCases.push({
      kind,
      lineStart: out.offset,
      lineBytes: total,
      boundary,
      splitAt,
      // The tests assert this is true for every case; if the arithmetic above
      // ever drifts, the fixture says so rather than silently losing coverage.
      onChunkBoundary: boundary % CHUNK === 0,
    });
    m.kept++;
    m.maxIndex = index;
    m.tokensInKeptLines += 1;
    m.keptWithReqId++;
    seqSeen.add(reqId);
    await emit(text, eol);
  };

  await boundaryLine('token-tail-then-boundary', 1, '\n'); // boundary between token and \n
  await boundaryLine('boundary-after-newline', 0, '\n'); // boundary right after \n
  await boundaryLine('boundary-inside-token', 12, '\n'); // boundary inside the token
  await boundaryLine('boundary-inside-crlf', 1, '\r\n'); // boundary between \r and \n

  // 2. A single line larger than 8MB.
  {
    index++;
    const filler = words(rand, 12).repeat(4);
    const head = `{"ts":1700000000001,"level":"error","reqId":"rHUGE","msg":"#${index} `;
    const tail = ` auth Bearer ${token(rand)}"}`;
    const need = HUGE_LINE_BYTES - head.length - tail.length;
    const body = filler.repeat(Math.ceil(need / filler.length)).slice(0, need);
    const text = head + body + tail;
    m.hugeLineBytes = Buffer.byteLength(text);
    m.kept++;
    m.maxIndex = index;
    m.tokensInKeptLines += 1;
    m.keptWithReqId++;
    seqSeen.add('rHUGE');
    await emit(text, '\n');
  }

  // 3. Malformed lines: unparseable, plus valid JSON of the wrong shape.
  for (const bad of [
    '{"ts":1700000000002,"level":"info","msg":"truncated',
    'not json at all',
    '[1,2,3]',
    '{"ts":1,"level":"info"}', // no msg
    '',
  ]) {
    m.rejected++;
    await emit(bad, '\n');
  }

  // --- bulk body ---
  while (out.offset < sizeBytes) {
    const eol = rand() < 0.3 ? '\r\n' : '\n';
    if (rand() < 0.01) {
      m.rejected++;
      index++;
      await emit(`{"ts":${1700000000000 + index * 7},"level":"info","msg":"#${index} broke`, eol);
    } else {
      await emit(record(), eol);
    }
  }

  // 4. A final line with no trailing newline.
  index++;
  m.kept++;
  m.maxIndex = index;
  m.keptWithReqId++;
  seqSeen.add('rLAST');
  m.totalLines++;
  m.endsWithNewline = false;
  await out.write(
    JSON.stringify({ ts: 1700000000009, level: 'error', msg: `#${index} final line no newline`, reqId: 'rLAST' }),
  );

  m.bytes = out.offset;
  m.distinctReqIds = seqSeen.size;

  stream.end();
  await finished(stream);
  await writeFile(`${outPath}.manifest.json`, JSON.stringify(m, null, 2));
  return m;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const [out, mb = '200', seed = '1'] = process.argv.slice(2);
  if (!out) {
    console.error('usage: node make-fixture.mjs <output> [sizeMB=200] [seed=1]');
    process.exit(2);
  }
  const m = await makeFixture(out, Number(mb) * 1024 * 1024, Number(seed));
  console.error(
    `${out}: ${(m.bytes / 1048576).toFixed(1)}MB, ${m.totalLines} lines ` +
      `(${m.kept} kept, ${m.dropped} debug, ${m.rejected} malformed, ` +
      `${m.crlfLines} CRLF, huge line ${m.hugeLineBytes} bytes)`,
  );
}
