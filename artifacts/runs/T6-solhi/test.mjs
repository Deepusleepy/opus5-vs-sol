import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLineSplitter, processLogFile } from './process-logs.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const MIB = 1024 * 1024;

test('LineSplitter handles CRLF, missing newline, UTF-8, and one-byte chunks', async () => {
  const input = Buffer.from('first\r\n\nBearer edge.Token-1\n雪\nlast', 'utf8');
  const chunks = Array.from(input, (byte) => Buffer.from([byte]));
  const actual = [];

  await pipeline(
    Readable.from(chunks),
    createLineSplitter(),
    new Writable({
      objectMode: true,
      write(record, _encoding, callback) {
        actual.push({ lineNumber: record.lineNumber, line: record.line.toString('utf8') });
        callback();
      },
    }),
  );

  assert.deepEqual(actual, [
    { lineNumber: 1, line: 'first' },
    { lineNumber: 2, line: '' },
    { lineNumber: 3, line: 'Bearer edge.Token-1' },
    { lineNumber: 4, line: '雪' },
    { lineNumber: 5, line: 'last' },
  ]);
});

test('50 MiB fixture stays bounded and preserves all transformations', { timeout: 180_000 }, async (t) => {
  const tempDirectory = await mkdtemp(join(HERE, '.test-'));
  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  const inputPath = join(tempDirectory, 'fixture.ndjson');
  const outputPath = join(tempDirectory, 'processed.ndjson');
  const fixtureResult = await execFileAsync(
    process.execPath,
    [join(HERE, 'make-fixture.mjs'), inputPath, '50', '1592594996'],
    { maxBuffer: MIB },
  );
  const fixtureStats = JSON.parse(fixtureResult.stdout.trim());
  assert.equal(fixtureStats.bytes, 50 * MIB);

  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 2);

  try {
    await processLogFile(inputPath, outputPath);
    peak = Math.max(peak, process.memoryUsage().rss);
  } finally {
    clearInterval(sampler);
  }

  const increase = peak - baseline;
  assert.ok(
    increase < 150 * MIB,
    `peak RSS rose ${(increase / MIB).toFixed(1)} MiB (baseline ${(baseline / MIB).toFixed(1)} MiB, peak ${(peak / MIB).toFixed(1)} MiB)`,
  );
  t.diagnostic(
    `50 MiB pipeline RSS: baseline ${(baseline / MIB).toFixed(1)} MiB, peak ${(peak / MIB).toFixed(1)} MiB, increase ${(increase / MIB).toFixed(1)} MiB`,
  );

  let outputLines = 0;
  let previousOrder = 0;
  let redactedLines = 0;
  let sawStart = false;
  let sawAfterMalformed = false;
  let sawBoundary = false;
  let sawHuge = false;
  const sequenceByRequest = new Map();
  const outputReader = createInterface({
    input: createReadStream(outputPath),
    crlfDelay: Infinity,
  });

  for await (const line of outputReader) {
    outputLines += 1;
    const entry = JSON.parse(line);
    assert.notEqual(entry.level, 'debug');
    assert.ok(entry.order > previousOrder, `output order regressed at order ${entry.order}`);
    previousOrder = entry.order;

    if (typeof entry.msg === 'string') {
      assert.doesNotMatch(entry.msg, /Bearer [A-Za-z0-9._-]+/);
      if (entry.msg.includes('Bearer [REDACTED]')) redactedLines += 1;
    }

    if (typeof entry.reqId === 'string') {
      const expectedSequence = (sequenceByRequest.get(entry.reqId) ?? 0) + 1;
      sequenceByRequest.set(entry.reqId, expectedSequence);
      assert.equal(entry.seq, expectedSequence, `wrong sequence for ${entry.reqId}`);
    }

    if (entry.marker === 'start') {
      sawStart = true;
      assert.equal(entry.seq, 1);
      assert.equal(entry.msg, 'fixture start Bearer [REDACTED]');
    } else if (entry.marker === 'after-malformed') {
      sawAfterMalformed = true;
      assert.equal(entry.seq, 2, 'a dropped debug line must not consume a sequence number');
    } else if (entry.marker === 'boundary') {
      sawBoundary = true;
      assert.ok(entry.msg.endsWith('Bearer [REDACTED]'));
    } else if (entry.marker === 'huge') {
      sawHuge = true;
      assert.ok(entry.msg.length > 8 * MIB);
      assert.ok(entry.msg.startsWith('HHHH'));
    }
  }

  assert.equal(outputLines, fixtureStats.emittedLines);
  assert.ok(redactedLines >= 3);
  assert.ok(sawStart && sawAfterMalformed && sawBoundary && sawHuge);

  const rejectLineNumbers = [];
  const rejectsReader = createInterface({
    input: createReadStream(`${outputPath}.rejects`),
    crlfDelay: Infinity,
  });
  for await (const line of rejectsReader) {
    const reject = JSON.parse(line);
    assert.equal(typeof reject.line, 'number');
    assert.equal(typeof reject.raw, 'string');
    let parsed;
    let syntacticallyValid = true;
    try {
      parsed = JSON.parse(reject.raw);
    } catch {
      syntacticallyValid = false;
    }
    if (syntacticallyValid) {
      assert.ok(parsed === null || typeof parsed !== 'object' || Array.isArray(parsed));
    }
    rejectLineNumbers.push(reject.line);
  }

  assert.equal(rejectLineNumbers.length, fixtureStats.rejectedLines);
  assert.deepEqual(rejectLineNumbers, fixtureStats.rejectLineNumbers);

  const inputFile = await open(inputPath, 'r');
  try {
    const { size } = await inputFile.stat();
    const finalByte = Buffer.alloc(1);
    await inputFile.read(finalByte, 0, 1, size - 1);
    assert.notEqual(finalByte[0], 0x0a, 'fixture must omit the final newline');
  } finally {
    await inputFile.close();
  }
});
