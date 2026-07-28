import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { splitLines, processLogs, backpressuredWrite } from './process-logs.mjs';
import { makeFixture, CHUNK } from './make-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

let dir;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'logpipe-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const collect = async (iter) => {
  const out = [];
  for await (const v of iter) out.push(v);
  return out;
};

// Feed a buffer through splitLines in fixed-size pieces.
const chunked = (buf, size) =>
  Readable.from(
    (function* () {
      for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
    })(),
    { objectMode: true },
  );

// --------------------------------------------------------------------------
// splitLines
// --------------------------------------------------------------------------

test('splitLines: identical output for every chunking, including 1-byte chunks', async () => {
  const input = Buffer.from(
    ['alpha', 'beta', '', 'a'.repeat(200), 'gammaé中\u{1f600}', 'delta'].join('\n') + '\n',
  );
  const expected = ['alpha', 'beta', '', 'a'.repeat(200), 'gammaé中\u{1f600}', 'delta'];

  for (const size of [1, 2, 3, 5, 7, 64, 199, 1024, input.length, input.length * 2]) {
    assert.deepEqual(
      await collect(splitLines(chunked(input, size))),
      expected,
      `chunk size ${size}`,
    );
  }
});

test('splitLines: 1-byte chunks split every multi-byte character', async () => {
  // Each of these characters is 2, 3 and 4 UTF-8 bytes; with 1-byte chunks the
  // splitter must not decode until the whole line is assembled.
  const line = 'é中\u{1f600} tail';
  const got = await collect(splitLines(chunked(Buffer.from(line + '\n'), 1)));
  assert.deepEqual(got, [line]);
});

test('splitLines: CRLF, bare CR, and mixed line endings', async () => {
  const input = Buffer.from('a\r\nb\nc\r\n\r\nd\r');
  // Trailing CR on the last (newline-less) line is stripped too; a lone CR in
  // the middle of a line is not a terminator.
  assert.deepEqual(await collect(splitLines(chunked(input, 1))), ['a', 'b', 'c', '', 'd']);

  const embedded = Buffer.from('x\ry\n');
  assert.deepEqual(await collect(splitLines(chunked(embedded, 1))), ['x\ry']);
});

test('splitLines: missing trailing newline yields the final line', async () => {
  assert.deepEqual(await collect(splitLines(chunked(Buffer.from('a\nb'), 1))), ['a', 'b']);
  assert.deepEqual(await collect(splitLines(chunked(Buffer.from('a\nb\n'), 1))), ['a', 'b']);
  assert.deepEqual(await collect(splitLines(chunked(Buffer.from(''), 1))), []);
  assert.deepEqual(await collect(splitLines(chunked(Buffer.from('\n'), 1))), ['']);
});

test('splitLines: a single line far larger than one chunk', async () => {
  const long = 'z'.repeat(CHUNK * 3 + 17);
  const got = await collect(splitLines(chunked(Buffer.from(`head\n${long}\ntail\n`), 4096)));
  assert.deepEqual(got, ['head', long, 'tail']);
});

test('splitLines: chunk boundary exactly at, before, and after a newline', async () => {
  const a = 'a'.repeat(10);
  const b = 'b'.repeat(10);
  const buf = Buffer.from(`${a}\r\n${b}\n`);
  // Cut the buffer at every possible offset; the result must never change.
  for (let cut = 1; cut < buf.length; cut++) {
    const src = Readable.from([buf.subarray(0, cut), buf.subarray(cut)], { objectMode: true });
    assert.deepEqual(await collect(splitLines(src)), [a, b], `cut at ${cut}`);
  }
});

// --------------------------------------------------------------------------
// transformations, on hand-written input with known-exact expected output
// --------------------------------------------------------------------------

test('transformations: redaction, seq, drops, rejects, order', async () => {
  const input = path.join(dir, 'small.ndjson');
  const output = path.join(dir, 'small.out');
  const lines = [
    '{"ts":1,"level":"info","msg":"one","reqId":"a"}', // 1 -> seq 1
    '{"ts":2,"level":"debug","msg":"drop me","reqId":"a"}', // 2 -> dropped (does NOT consume a seq)
    '{"ts":3,"level":"warn","msg":"tok Bearer aB9._-xyz end","reqId":"b"}', // 3 -> seq 1, redacted
    'this is not json', // 4 -> reject
    '{"ts":5,"level":"error","msg":"two","reqId":"a"}', // 5 -> seq 2
    '{"ts":6,"level":"info","msg":"no req id here"}', // 6 -> no seq
    '{"ts":7,"level":"info","msg":"Bearer AAA and Bearer BBB"}', // 7 -> two redactions
    '{"ts":8,"level":"info","msg":"trailing token Bearer ZZZ"}', // 8 -> token at end of line
    '{"broken":', // 9 -> reject
    '{"ts":10,"level":"info"}', // 10 -> reject (no msg)
    '{"ts":11,"level":"info","msg":"last","reqId":"b"}', // 11 -> seq 2, no trailing newline
  ];
  // CRLF on some lines, and no newline after the last one.
  await writeFile(input, lines.map((l, i) => (i % 3 === 0 ? l + '\r\n' : l + '\n')).join('').slice(0, -1));

  const stats = await processLogs(input, output);
  assert.deepEqual(stats, { lines: 11, written: 7, dropped: 1, rejected: 3, reqIds: 2 });

  const got = (await readFile(output, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(got, [
    { ts: 1, level: 'info', msg: 'one', reqId: 'a', seq: 1 },
    { ts: 3, level: 'warn', msg: 'tok Bearer [REDACTED] end', reqId: 'b', seq: 1 },
    { ts: 5, level: 'error', msg: 'two', reqId: 'a', seq: 2 },
    { ts: 6, level: 'info', msg: 'no req id here' },
    { ts: 7, level: 'info', msg: 'Bearer [REDACTED] and Bearer [REDACTED]' },
    { ts: 8, level: 'info', msg: 'trailing token Bearer [REDACTED]' },
    { ts: 11, level: 'info', msg: 'last', reqId: 'b', seq: 2 },
  ]);

  const rejects = (await readFile(`${output}.rejects`, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(
    rejects.map((r) => r.line),
    [4, 9, 10],
    'rejects carry 1-based input line numbers',
  );
  assert.equal(rejects[0].raw, 'this is not json');
  assert.equal(rejects[2].raw, '{"ts":10,"level":"info"}');
  for (const r of rejects) assert.equal(typeof r.reason, 'string');
});

test('transformations: redaction leaves non-token text alone', async () => {
  const input = path.join(dir, 'redact.ndjson');
  const output = path.join(dir, 'redact.out');
  await writeFile(
    input,
    [
      '{"ts":1,"level":"info","msg":"Bearer"}', // no token -> untouched
      '{"ts":2,"level":"info","msg":"Bearer "}', // empty token -> untouched
      '{"ts":3,"level":"info","msg":"bearer abc"}', // lowercase -> untouched
      '{"ts":4,"level":"info","msg":"Bearer a/b+c"}', // stops at the first char outside the class
      '{"ts":5,"level":"info","msg":"say \\"Bearer tok\\" now"}', // quoted token still redacted
    ].join('\n') + '\n',
  );
  await processLogs(input, output);
  assert.deepEqual(
    (await readFile(output, 'utf8')).trimEnd().split('\n').map((l) => JSON.parse(l).msg),
    ['Bearer', 'Bearer ', 'bearer abc', 'Bearer [REDACTED]/b+c', 'say "Bearer [REDACTED]" now'],
  );
});

test('rejects are written with backpressure, not buffered without limit', async () => {
  // A sink that never calls back until released, so anything the writer does
  // not wait for piles up in the stream's internal buffer.
  const pendingCbs = [];
  const sink = new Writable({
    highWaterMark: 1024,
    write(chunk, enc, cb) {
      pendingCbs.push(cb);
    },
  });
  // A Writable only has one write in flight at a time, so completing a
  // callback releases the next buffered chunk into _write. Keep going until
  // the queue is genuinely empty, otherwise 'drain' never fires.
  const releaseAll = async () => {
    while (pendingCbs.length > 0) {
      for (const cb of pendingCbs.splice(0)) cb();
      await new Promise((r) => setImmediate(r));
    }
  };

  const write = backpressuredWrite(sink);
  const line = 'x'.repeat(512);

  // The first write is accepted; once the 1KB watermark is exceeded, the
  // writer must hand back a promise instead of returning undefined.
  let waited = null;
  let n = 0;
  while (waited === null && n < 100) {
    n++;
    waited = write(line) ?? null;
  }
  assert.ok(waited, 'writer signalled backpressure within a few KB');
  assert.ok(n <= 5, `backpressure appeared after ${n} writes of 512B into a 1KB buffer`);

  // The returned promise must stay pending until the sink actually drains.
  let settled = false;
  waited.then(() => {
    settled = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'the write promise does not resolve while the sink is blocked');

  await releaseAll();
  await waited; // resolves once 'drain' fires
  assert.equal(settled, true);
});

test('empty input produces empty output and empty rejects', async () => {
  const input = path.join(dir, 'empty.ndjson');
  const output = path.join(dir, 'empty.out');
  await writeFile(input, '');
  const stats = await processLogs(input, output);
  assert.deepEqual(stats, { lines: 0, written: 0, dropped: 0, rejected: 0, reqIds: 0 });
  assert.equal(await readFile(output, 'utf8'), '');
  assert.equal(await readFile(`${output}.rejects`, 'utf8'), '');
});

test('a missing input file rejects rather than hanging', async () => {
  await assert.rejects(
    () => processLogs(path.join(dir, 'nope.ndjson'), path.join(dir, 'nope.out')),
    { code: 'ENOENT' },
  );
});

// --------------------------------------------------------------------------
// end to end on a 50MB fixture, with RSS sampling
// --------------------------------------------------------------------------

const RSS_BUDGET_MB = 150;

test('50MB fixture: bounded RSS, correct output, order preserved', async (t) => {
  const input = path.join(dir, 'big.ndjson');
  const output = path.join(dir, 'big.out');

  const manifest = await makeFixture(input, 50 * 1024 * 1024, 1);
  assert.ok(manifest.bytes >= 50 * 1024 * 1024, 'fixture is at least 50MB');
  assert.ok(manifest.hugeLineBytes > 8 * 1024 * 1024, 'fixture contains a >8MB single line');
  assert.ok(manifest.crlfLines > 1000, 'fixture mixes CRLF line endings');
  assert.equal(manifest.endsWithNewline, false, 'fixture has no trailing newline');
  assert.equal(manifest.boundaryCases.length, 4);
  for (const c of manifest.boundaryCases) {
    assert.ok(c.onChunkBoundary, `${c.kind} lands on a ${CHUNK}-byte read boundary`);
  }

  // Run the pipeline in a fresh process so the baseline RSS is that of a bare
  // interpreter, uncontaminated by fixture generation, and sample its own
  // process.memoryUsage().rss while it works.
  const runner = `
    const sample = () => process.memoryUsage().rss;
    const baseline = sample();
    let peak = baseline;
    const timer = setInterval(() => { const r = sample(); if (r > peak) peak = r; }, 2);
    const { processLogs } = await import(${JSON.stringify(pathToFileURL(path.join(HERE, 'process-logs.mjs')).href)});
    const stats = await processLogs(${JSON.stringify(input)}, ${JSON.stringify(output)});
    clearInterval(timer);
    const final = sample();
    if (final > peak) peak = final;
    console.log(JSON.stringify({ baseline, peak, stats }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', runner], {
    maxBuffer: 1 << 20,
  });
  const { baseline, peak, stats } = JSON.parse(stdout);

  const overMB = (peak - baseline) / 1048576;
  t.diagnostic(
    `input ${(manifest.bytes / 1048576).toFixed(1)}MB | baseline RSS ` +
      `${(baseline / 1048576).toFixed(1)}MB | peak RSS ${(peak / 1048576).toFixed(1)}MB | ` +
      `delta ${overMB.toFixed(1)}MB (budget ${RSS_BUDGET_MB}MB)`,
  );
  assert.ok(
    overMB < RSS_BUDGET_MB,
    `peak RSS was ${overMB.toFixed(1)}MB above baseline, budget is ${RSS_BUDGET_MB}MB`,
  );

  // Counts must match what the generator recorded as it wrote the fixture.
  assert.equal(stats.lines, manifest.totalLines);
  assert.equal(stats.written, manifest.kept);
  assert.equal(stats.dropped, manifest.dropped);
  assert.equal(stats.rejected, manifest.rejected);
  assert.equal(stats.reqIds, manifest.distinctReqIds);

  // Stream the output back and re-derive every property independently.
  const seq = new Map();
  let count = 0;
  let redactions = 0;
  let lastIndex = 0;
  let sawHuge = false;
  const residualToken = /Bearer [A-Za-z0-9._-]+/;

  for await (const line of splitLines(createReadStream(output))) {
    const rec = JSON.parse(line);
    count++;

    // Order: msgs carry a strictly increasing "#<index>" written by the generator.
    const index = Number(/^#(\d+)/.exec(rec.msg)[1]);
    assert.ok(index > lastIndex, `output out of order at record ${count}: ${index} <= ${lastIndex}`);
    lastIndex = index;

    assert.notEqual(rec.level, 'debug', 'no debug line survived');

    const redacted = rec.msg.split('Bearer [REDACTED]').length - 1;
    redactions += redacted;
    if (redacted > 0) {
      assert.ok(!residualToken.test(rec.msg.replaceAll('Bearer [REDACTED]', '')), 'no token left');
    }
    assert.ok(!residualToken.test(rec.msg), `unredacted token in record ${count}`);

    if (rec.reqId === undefined) {
      assert.equal(rec.seq, undefined, 'seq only appears with a reqId');
    } else {
      const expected = (seq.get(rec.reqId) ?? 0) + 1;
      seq.set(rec.reqId, expected);
      assert.equal(rec.seq, expected, `seq for ${rec.reqId} at record ${count}`);
    }

    if (rec.msg.length > 8 * 1024 * 1024) sawHuge = true;
  }

  assert.equal(count, manifest.kept, 'every kept line reached the output');
  assert.equal(redactions, manifest.tokensInKeptLines, 'every token was redacted, exactly once');
  assert.equal(seq.size, manifest.distinctReqIds);
  assert.equal(lastIndex, manifest.maxIndex, 'the final newline-less line was processed');
  assert.ok(sawHuge, 'the >8MB line survived intact');

  // Rejects: one per malformed line, in input order, with 1-based line numbers.
  let rejectCount = 0;
  let lastRejectLine = 0;
  for await (const line of splitLines(createReadStream(`${output}.rejects`))) {
    const r = JSON.parse(line);
    rejectCount++;
    assert.ok(r.line > lastRejectLine, 'reject line numbers increase');
    assert.ok(r.line <= manifest.totalLines, 'reject line number is within the input');
    lastRejectLine = r.line;
    assert.equal(typeof r.raw, 'string');
  }
  assert.equal(rejectCount, manifest.rejected);
});

test('the fixture is deterministic for a given seed', async () => {
  const a = path.join(dir, 'seed-a.ndjson');
  const b = path.join(dir, 'seed-b.ndjson');
  const c = path.join(dir, 'seed-c.ndjson');
  await makeFixture(a, 400 * 1024, 42);
  await makeFixture(b, 400 * 1024, 42);
  await makeFixture(c, 400 * 1024, 43);
  const [ba, bb, bc] = await Promise.all([readFile(a), readFile(b), readFile(c)]);
  assert.ok(ba.equals(bb), 'same seed, same bytes');
  assert.ok(!ba.equals(bc), 'different seed, different bytes');
});
