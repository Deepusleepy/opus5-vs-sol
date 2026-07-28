import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, statSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';

import { LineSplitter, processLogs } from './process-logs.mjs';
import { writeFixture, PLAN } from './make-fixture.mjs';

const dir = mkdtempSync(join(tmpdir(), 'logpipe-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------- unit tests

async function split(chunks) {
  const out = [];
  await pipeline(Readable.from(chunks), new LineSplitter(), async function (src) {
    for await (const line of src) out.push(line);
  });
  return out;
}

test('LineSplitter: CRLF, LF and missing trailing newline', async () => {
  assert.deepEqual(await split([Buffer.from('a\r\nb\nc')]), ['a', 'b', 'c']);
  assert.deepEqual(await split([Buffer.from('a\n')]), ['a']);
  assert.deepEqual(await split([Buffer.from('\n\n')]), ['', '']);
  assert.deepEqual(await split([]), []);
});

test('LineSplitter: 1-byte chunks give the same result as one chunk', async () => {
  const text = 'first\r\nsecond\nthird line here\r\n\nlast without newline';
  const whole = await split([Buffer.from(text)]);
  const bytes = [...Buffer.from(text)].map((b) => Buffer.from([b]));
  assert.deepEqual(await split(bytes), whole);
  assert.deepEqual(whole, ['first', 'second', 'third line here', '', 'last without newline']);
});

test('LineSplitter: CR and LF arriving in separate chunks', async () => {
  assert.deepEqual(await split([Buffer.from('a\r'), Buffer.from('\nb\n')]), ['a', 'b']);
});

test('LineSplitter: multi-byte UTF-8 split across chunks', async () => {
  const buf = Buffer.from('héllo → wörld\n');
  const bytes = [...buf].map((b) => Buffer.from([b]));
  assert.deepEqual(await split(bytes), ['héllo → wörld']);
});

test('LineSplitter: a single line far larger than any chunk', async () => {
  const line = 'z'.repeat(3_000_000);
  const buf = Buffer.from(line + '\n');
  const chunks = [];
  for (let i = 0; i < buf.length; i += 7919) chunks.push(buf.subarray(i, i + 7919));
  assert.deepEqual(await split(chunks), [line]);
});

// -------------------------------------------------------------- small e2e

test('transformations: redaction, seq, debug drop, rejects, order', async () => {
  const input = join(dir, 'small.ndjson');
  const output = join(dir, 'small.out');
  writeFileSync(input, [
    '{"ts":1,"level":"debug","msg":"noise","reqId":"a"}',
    '{"ts":2,"level":"info","msg":"auth Bearer abc.DEF-123_x ok","reqId":"a"}',
    'this is not json',
    '{"ts":3,"level":"warn","msg":"two Bearer aaa and Bearer bbb","reqId":"b"}',
    '{"ts":4,"level":"error","msg":"no req id"}',
    '{"ts":5,"level":"info","msg":"second for a","reqId":"a"}\r',
    '[1,2,3]',
    '{"ts":6,"level":"info","msg":"last, no trailing newline","reqId":"b"}',
  ].join('\n'));

  const stats = await processLogs(input, output);
  assert.deepEqual(stats, { lines: 8, blank: 0, dropped: 1, rejected: 2, written: 5 });

  const lines = readFileSync(output, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.ts), [2, 3, 4, 5, 6], 'input order preserved');
  assert.equal(lines[0].msg, 'auth Bearer [REDACTED] ok');
  assert.equal(lines[1].msg, 'two Bearer [REDACTED] and Bearer [REDACTED]');
  assert.deepEqual(lines.map((l) => l.seq), [1, 1, undefined, 2, 2], 'seq is per reqId');
  assert.ok(!('seq' in lines[2]), 'lines without reqId get no seq');

  assert.equal(
    readFileSync(`${output}.rejects`, 'utf8'),
    '3: this is not json\n7: [1,2,3]\n',
  );
});

// ------------------------------------------------------- 50MB memory + e2e

test('50MB fixture: bounded RSS and correct output', { timeout: 600_000 }, async () => {
  const input = join(dir, 'big.ndjson');
  const output = join(dir, 'big.out');
  await writeFixture(input, 50 * 1024 * 1024, 7);
  const inputSize = statSync(input).size;
  assert.ok(inputSize >= 50 * 1024 * 1024, `fixture is ${inputSize} bytes`);

  global.gc?.();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  let stats;
  try {
    stats = await processLogs(input, output);
  } finally {
    clearInterval(sampler);
  }
  peak = Math.max(peak, process.memoryUsage().rss);

  const growthMB = (peak - baseline) / 1024 / 1024;
  console.log(
    `input ${(inputSize / 1024 / 1024).toFixed(1)}MB  lines ${stats.lines}  ` +
    `written ${stats.written}  dropped ${stats.dropped}  rejected ${stats.rejected}\n` +
    `rss baseline ${(baseline / 1024 / 1024).toFixed(1)}MB  peak ${(peak / 1024 / 1024).toFixed(1)}MB  ` +
    `growth ${growthMB.toFixed(1)}MB`,
  );
  assert.ok(growthMB < 150, `peak RSS grew ${growthMB.toFixed(1)}MB above baseline`);

  assert.equal(stats.rejected, PLAN.malformed);
  assert.ok(stats.dropped > 0, 'debug lines were dropped');

  // Rejects carry the 1-based input line numbers of the malformed lines.
  assert.deepEqual(
    readFileSync(`${output}.rejects`, 'utf8').trimEnd().split('\n').map((l) => Number(l.split(':')[0])),
    Array.from({ length: PLAN.malformed }, (_, i) => i + 1),
  );

  // Single streaming pass over the output: no buffering of the whole file.
  const seq = new Map();
  let count = 0;
  let lastTs = -Infinity;
  let redacted = 0;
  let huge = 0;
  const rl = createInterface({ input: createReadStream(output), crlfDelay: Infinity });
  for await (const line of rl) {
    const rec = JSON.parse(line);
    count++;
    assert.notEqual(rec.level, 'debug');
    assert.ok(!/Bearer (?!\[REDACTED\])/.test(rec.msg), `unredacted token: ${rec.msg.slice(0, 80)}`);
    if (rec.msg.includes('Bearer [REDACTED]')) redacted++;
    if (rec.msg.length > 8 * 1024 * 1024) huge++;
    assert.ok(rec.ts > lastTs, 'output preserves input order');
    lastTs = rec.ts;
    if (rec.reqId !== undefined) {
      const expected = (seq.get(rec.reqId) ?? 0) + 1;
      assert.equal(rec.seq, expected, `seq for ${rec.reqId}`);
      seq.set(rec.reqId, expected);
    } else {
      assert.ok(!('seq' in rec));
    }
  }
  assert.equal(count, stats.written);
  assert.equal(huge, PLAN.huge, 'huge >8MB lines survived the pipeline');
  assert.ok(redacted > PLAN.boundary, 'chunk-boundary tokens were redacted');
});
