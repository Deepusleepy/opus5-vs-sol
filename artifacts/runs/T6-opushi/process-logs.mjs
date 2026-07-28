#!/usr/bin/env node
// Streaming newline-delimited-JSON log processor.
//
// Reads <input>, writes transformed lines to <output> and unparseable lines to
// <output>.rejects. Runs in bounded memory regardless of input size: the only
// state that grows is the per-reqId sequence counter map.

import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline, finished } from 'node:stream/promises';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const NEWLINE = 0x0a;
const CR = 0x0d;
const BEARER = /Bearer [A-Za-z0-9._-]+/g;

/**
 * Split a stream of Buffers into lines.
 *
 * Yields one string per line, with the trailing CR of a CRLF pair removed. A
 * final line without a trailing newline is yielded too. Lines may span any
 * number of chunks and may individually exceed one chunk; only the bytes of the
 * single line currently being assembled are held, never a list of lines.
 *
 * Decoding happens per complete line, which is safe for UTF-8 because 0x0A
 * never appears inside a multi-byte sequence -- so a multi-byte character split
 * across a chunk boundary is reassembled before it is decoded.
 */
export async function* splitLines(source) {
  let pending = []; // pieces of the line currently being assembled
  let pendingLen = 0;

  for await (const chunk of source) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(NEWLINE, start)) !== -1) {
      const piece = chunk.subarray(start, nl);
      let line;
      if (pendingLen === 0) {
        line = piece;
      } else {
        pending.push(piece);
        line = Buffer.concat(pending, pendingLen + piece.length);
        pending = [];
        pendingLen = 0;
      }
      yield decodeLine(line);
      start = nl + 1;
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      pending.push(tail);
      pendingLen += tail.length;
    }
  }

  if (pendingLen > 0) yield decodeLine(Buffer.concat(pending, pendingLen));
}

function decodeLine(buf) {
  if (buf.length > 0 && buf[buf.length - 1] === CR) buf = buf.subarray(0, -1);
  return buf.toString('utf8');
}

/**
 * Apply the transformations to a stream of lines, in order.
 *
 * Yields the output text (JSON + "\n") for every line that survives. Malformed
 * lines are handed to `onReject(lineNo, reason, raw)`, which is awaited so that
 * writing rejects applies backpressure to the whole pipeline.
 *
 * `stats` is mutated in place so the caller can report counts.
 */
export async function* transformLines(lines, onReject, stats) {
  const seqByReqId = new Map();
  let lineNo = 0;

  for await (const line of lines) {
    lineNo++;
    stats.lines++;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      stats.rejected++;
      await onReject(lineNo, err.message, line);
      continue;
    }
    // Validate exactly the fields the transformations depend on. `ts` is
    // carried through untouched and deliberately not validated.
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      stats.rejected++;
      await onReject(lineNo, 'not a JSON object', line);
      continue;
    }
    if (typeof rec.level !== 'string' || typeof rec.msg !== 'string') {
      stats.rejected++;
      await onReject(lineNo, 'missing or non-string "level"/"msg"', line);
      continue;
    }

    if (rec.level === 'debug') {
      stats.dropped++;
      continue;
    }

    rec.msg = rec.msg.replace(BEARER, 'Bearer [REDACTED]');

    if (typeof rec.reqId === 'string') {
      const seq = (seqByReqId.get(rec.reqId) ?? 0) + 1;
      seqByReqId.set(rec.reqId, seq);
      rec.seq = seq;
    }

    stats.written++;
    yield JSON.stringify(rec) + '\n';
  }

  stats.reqIds = seqByReqId.size;
}

/**
 * Write to `stream`, returning a promise only when we must wait for drain.
 *
 * Awaiting the result is what keeps the rejects file from buffering without
 * limit when its sink is slower than the input; returning `undefined` on the
 * common path avoids a promise allocation per line.
 */
export function backpressuredWrite(stream) {
  return (text) => (stream.write(text) ? undefined : once(stream, 'drain'));
}

/**
 * Process `input` into `output` (+ `<output>.rejects`). Resolves with stats.
 */
export async function processLogs(input, output) {
  const stats = { lines: 0, written: 0, dropped: 0, rejected: 0, reqIds: 0 };

  const rejects = createWriteStream(`${output}.rejects`);
  // Capture an early write error so it does not become an uncaught 'error'
  // before `finished()` below attaches its own handler.
  rejects.on('error', () => {});
  const writeReject = backpressuredWrite(rejects);

  const onReject = (lineNo, reason, raw) =>
    writeReject(JSON.stringify({ line: lineNo, reason, raw }) + '\n');

  try {
    await pipeline(
      createReadStream(input),
      splitLines,
      (lines) => transformLines(lines, onReject, stats),
      createWriteStream(output),
    );
  } finally {
    rejects.end();
  }
  await finished(rejects);

  return stats;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node process-logs.mjs <input> <output>');
    process.exit(2);
  }
  const started = Date.now();
  const stats = await processLogs(input, output);
  const secs = (Date.now() - started) / 1000;
  console.error(
    `read ${stats.lines} lines in ${secs.toFixed(1)}s: ` +
      `wrote ${stats.written}, dropped ${stats.dropped} debug, ` +
      `rejected ${stats.rejected}, tracked ${stats.reqIds} reqIds`,
  );
}
