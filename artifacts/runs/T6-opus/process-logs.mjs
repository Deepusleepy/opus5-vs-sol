#!/usr/bin/env node
// Streaming NDJSON log processor: drops debug lines, redacts bearer tokens,
// numbers lines per reqId, and diverts malformed lines to <output>.rejects.
// Memory stays bounded regardless of input size: nothing is accumulated except
// the per-reqId counters and, transiently, the bytes of the current line.

import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const LF = 0x0a;
const CR = 0x0d;
const BEARER = /Bearer [A-Za-z0-9._-]+/g;
const READ_CHUNK = 64 * 1024;

/**
 * Byte-level newline splitter. Input: Buffer chunks. Output: one string per
 * line, without the line terminator, tolerant of CRLF, of lines split across
 * any number of chunks, and of a missing trailing newline.
 */
export class LineSplitter extends Transform {
  #parts = [];

  constructor() {
    super({ readableObjectMode: true });
  }

  #emit(tail) {
    if (tail !== null) this.#parts.push(tail);
    let buf = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts);
    this.#parts.length = 0;
    if (buf.length > 0 && buf[buf.length - 1] === CR) buf = buf.subarray(0, -1);
    this.push(buf.toString('utf8'));
  }

  _transform(chunk, _enc, cb) {
    let start = 0;
    let i;
    while ((i = chunk.indexOf(LF, start)) !== -1) {
      this.#emit(chunk.subarray(start, i));
      start = i + 1;
    }
    // Carry the unterminated remainder; concatenated only once a newline shows up,
    // so a line spanning N chunks costs O(line) copying, not O(N * line).
    if (start < chunk.length) this.#parts.push(chunk.subarray(start));
    cb();
  }

  _flush(cb) {
    if (this.#parts.length > 0) this.#emit(null);
    cb();
  }
}

/**
 * Applies the transformations to one line at a time. Malformed lines are
 * written to the `rejects` stream; if that stream is full we wait for drain
 * before acknowledging the line, so backpressure reaches the file reader.
 */
export class LogProcessor extends Transform {
  constructor(rejects) {
    super({ writableObjectMode: true });
    this.rejects = rejects;
    this.seq = new Map();
    this.stats = { lines: 0, blank: 0, dropped: 0, rejected: 0, written: 0 };
  }

  #reject(line, cb) {
    this.stats.rejected++;
    if (this.rejects.write(`${this.stats.lines}: ${line}\n`)) cb();
    else this.rejects.once('drain', cb);
  }

  _transform(line, _enc, cb) {
    this.stats.lines++;
    if (line.length === 0) {
      this.stats.blank++;
      return cb();
    }

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return this.#reject(line, cb);
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      return this.#reject(line, cb);
    }

    if (rec.level === 'debug') {
      this.stats.dropped++;
      return cb();
    }
    if (typeof rec.msg === 'string') {
      rec.msg = rec.msg.replace(BEARER, 'Bearer [REDACTED]');
    }
    if (typeof rec.reqId === 'string') {
      const n = (this.seq.get(rec.reqId) ?? 0) + 1;
      this.seq.set(rec.reqId, n);
      rec.seq = n;
    }
    this.stats.written++;
    this.push(JSON.stringify(rec) + '\n');
    cb();
  }
}

export async function processLogs(input, output) {
  const rejects = createWriteStream(`${output}.rejects`);
  const proc = new LogProcessor(rejects);
  // A failure on the side channel must tear the main pipeline down too.
  rejects.on('error', (err) => proc.destroy(err));

  try {
    await pipeline(
      createReadStream(input, { highWaterMark: READ_CHUNK }),
      new LineSplitter(),
      proc,
      createWriteStream(output),
    );
  } catch (err) {
    rejects.destroy();
    throw err;
  }
  rejects.end();
  await finished(rejects);
  return proc.stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node process-logs.mjs <input> <output>');
    process.exit(2);
  }
  try {
    console.error(JSON.stringify(await processLogs(input, output)));
  } catch (err) {
    console.error(`process-logs: ${err.message}`);
    process.exit(1);
  }
}
