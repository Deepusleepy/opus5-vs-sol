import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeFixture } from './make-fixture.mjs';
import { LineSplitter, processLogs } from './process-logs.mjs';

const directory = dirname(fileURLToPath(import.meta.url));

async function readLines(path, inspect) {
  let count = 0;
  for await (const item of createReadStream(path).pipe(new LineSplitter())) {
    count += 1;
    await inspect(item.line, item.lineNumber);
  }
  return count;
}

test('LineSplitter handles CRLF, missing newline, UTF-8, and one-byte chunks', async () => {
  const input = Buffer.from('alpha\r\nβeta\n\nlast🙂', 'utf8');
  const chunks = Array.from(input, (byte) => Buffer.from([byte]));
  const found = [];
  await pipeline(
    Readable.from(chunks),
    new LineSplitter(),
    new Writable({
      objectMode: true,
      write(item, _encoding, callback) {
        found.push(item);
        callback();
      },
    }),
  );
  assert.deepEqual(found, [
    { lineNumber: 1, line: 'alpha' },
    { lineNumber: 2, line: 'βeta' },
    { lineNumber: 3, line: '' },
    { lineNumber: 4, line: 'last🙂' },
  ]);
});

test('pipeline processes a 50 MiB adversarial fixture in bounded memory', { timeout: 120_000 }, async (t) => {
  const fixture = join(directory, '.test-fixture.ndjson');
  const output = join(directory, '.test-output.ndjson');
  const rejects = `${output}.rejects`;
  t.after(async () => {
    await Promise.all([fixture, output, rejects].map((path) => rm(path, { force: true })));
  });

  const fixtureResult = await makeFixture(fixture, { sizeMB: 50, seed: 123456 });
  assert.ok(fixtureResult.bytes >= 50 * 1024 * 1024);

  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  try {
    await processLogs(fixture, output);
    peak = Math.max(peak, process.memoryUsage().rss);
  } finally {
    clearInterval(sampler);
  }
  const growth = peak - baseline;
  assert.ok(growth < 150 * 1024 * 1024, `peak RSS grew ${(growth / 1024 / 1024).toFixed(1)} MiB`);

  const expectedSequences = new Map();
  let outputCount = 0;
  let first;
  let second;
  let hugeSeen = false;
  let boundarySeen = false;
  let final;
  await readLines(output, (line) => {
    const record = JSON.parse(line);
    outputCount += 1;
    assert.notEqual(record.level, 'debug');
    assert.doesNotMatch(record.msg, /Bearer (?!\[REDACTED\])[A-Za-z0-9._-]+/);

    if (Object.prototype.hasOwnProperty.call(record, 'reqId')) {
      const expected = (expectedSequences.get(record.reqId) ?? 0) + 1;
      expectedSequences.set(record.reqId, expected);
      assert.equal(record.seq, expected, `sequence for ${record.reqId}`);
    }

    if (outputCount === 1) first = record;
    if (outputCount === 2) second = record;
    if (record.reqId === 'huge') {
      hugeSeen = true;
      assert.ok(record.msg.length > 8 * 1024 * 1024);
      assert.match(record.msg, /Bearer \[REDACTED\]/);
    }
    if (record.reqId === 'boundary') {
      boundarySeen = true;
      assert.ok(record.msg.endsWith('Bearer [REDACTED]'));
    }
    final = record;
  });

  assert.deepEqual(
    { ts: first.ts, level: first.level, msg: first.msg, reqId: first.reqId, seq: first.seq },
    { ts: 1, level: 'info', msg: 'fixture-start Bearer [REDACTED]', reqId: 'req-A', seq: 1 },
  );
  assert.deepEqual(
    { ts: second.ts, level: second.level, msg: second.msg, reqId: second.reqId, seq: second.seq },
    { ts: 3, level: 'warn', msg: 'fixture-second', reqId: 'req-A', seq: 2 },
  );
  assert.ok(hugeSeen);
  assert.ok(boundarySeen);
  assert.equal(final.reqId, 'final');
  assert.equal(final.msg, 'fixture-end Bearer [REDACTED]');
  assert.ok(outputCount > 10_000);

  let rejectCount = 0;
  await readLines(rejects, (line) => {
    const reject = JSON.parse(line);
    rejectCount += 1;
    assert.equal(typeof reject.line, 'number');
    assert.equal(typeof reject.raw, 'string');
    assert.equal(typeof reject.error, 'string');
    if (rejectCount === 1) {
      assert.equal(reject.line, 4);
      assert.equal(reject.raw, '{ definitely not json');
    }
  });
  assert.ok(rejectCount >= 2);
  t.diagnostic(`fixture ${(fixtureResult.bytes / 1024 / 1024).toFixed(1)} MiB; peak RSS growth ${(growth / 1024 / 1024).toFixed(1)} MiB; ${outputCount} accepted; ${rejectCount} rejected`);
});

test('CLI writes output and rejects without a trailing input newline', async (t) => {
  const input = join(directory, '.test-cli-input.ndjson');
  const output = join(directory, '.test-cli-output.ndjson');
  t.after(async () => {
    await Promise.all([input, output, `${output}.rejects`].map((path) => rm(path, { force: true })));
  });
  await writeFile(input, '{"ts":1,"level":"info","msg":"Bearer cli","reqId":"r"}\nnope');
  await processLogs(input, output, { highWaterMark: 1 });
  const records = [];
  await readLines(output, (line) => records.push(JSON.parse(line)));
  assert.equal(records[0].msg, 'Bearer [REDACTED]');
  const rejected = [];
  await readLines(`${output}.rejects`, (line) => rejected.push(JSON.parse(line)));
  assert.equal(rejected[0].line, 2);
});
