#!/usr/bin/env node

import { createReadStream, createWriteStream } from 'node:fs';
import { finished, pipeline } from 'node:stream/promises';
import { Duplex, Transform, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const BEARER_TOKEN = /Bearer [A-Za-z0-9._-]+/g;

/**
 * Splits a byte stream into numbered lines without assuming chunk boundaries.
 * The only input retained is the unfinished current line.
 */
export function createLineSplitter() {
  return Duplex.from(async function* splitLines(source) {
      let pending = Buffer.alloc(0);
      let pendingLength = 0;
      let lineNumber = 0;

      function append(fragment) {
        const required = pendingLength + fragment.length;
        if (required > pending.length) {
          const capacity = Math.max(required, Math.max(1024, pending.length * 2));
          const grown = Buffer.allocUnsafe(capacity);
          if (pendingLength > 0) pending.copy(grown, 0, 0, pendingLength);
          pending = grown;
        }
        fragment.copy(pending, pendingLength);
        pendingLength = required;
      }

      function numbered(line) {
        if (line.length > 0 && line[line.length - 1] === 0x0d) {
          line = line.subarray(0, line.length - 1);
        }
        lineNumber += 1;
        return { lineNumber, line: line.toString('utf8') };
      }

      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        let newline;

        while ((newline = bytes.indexOf(0x0a, start)) !== -1) {
          let line;
          if (pendingLength === 0) {
            line = bytes.subarray(start, newline);
          } else {
            append(bytes.subarray(start, newline));
            line = pending.subarray(0, pendingLength);
            pending = Buffer.alloc(0);
            pendingLength = 0;
          }
          start = newline + 1;
          const record = numbered(line);
          line = null;
          yield record;
        }

        if (start < bytes.length) append(bytes.subarray(start));
      }

      if (pendingLength > 0) {
        let line = pending.subarray(0, pendingLength);
        pending = Buffer.alloc(0);
        pendingLength = 0;
        const record = numbered(line);
        line = null;
        yield record;
      }
    });
}

class LogTransform extends Transform {
  #sequenceByRequest = new Map();

  constructor() {
    super({
      writableObjectMode: true,
      readableObjectMode: true,
      writableHighWaterMark: 1,
      readableHighWaterMark: 1,
    });
  }

  _transform({ lineNumber, line }, _encoding, callback) {
    const raw = line;
    let entry;

    try {
      entry = JSON.parse(raw);
    } catch {
      entry = null;
    }

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      this.push({
        destination: 'rejects',
        data: Buffer.from(`${JSON.stringify({ line: lineNumber, raw })}\n`),
      });
      callback();
      return;
    }

    if (entry.level === 'debug') {
      callback();
      return;
    }

    if (typeof entry.msg === 'string') {
      entry.msg = entry.msg.replace(BEARER_TOKEN, 'Bearer [REDACTED]');
    }

    if (typeof entry.reqId === 'string') {
      const sequence = (this.#sequenceByRequest.get(entry.reqId) ?? 0) + 1;
      this.#sequenceByRequest.set(entry.reqId, sequence);
      entry.seq = sequence;
    }

    this.push({ destination: 'output', data: Buffer.from(`${JSON.stringify(entry)}\n`) });
    callback();
  }
}

/** Routes each transformed record to one of two backpressure-aware outputs. */
class OutputRouter extends Writable {
  #output;
  #rejects;
  #destinationError;

  constructor(outputPath) {
    super({ objectMode: true, highWaterMark: 1 });
    this.#output = createWriteStream(outputPath);
    this.#rejects = createWriteStream(`${outputPath}.rejects`);
    this.#destinationError = (error) => this.destroy(error);
    this.#output.on('error', this.#destinationError);
    this.#rejects.on('error', this.#destinationError);
  }

  _write(record, _encoding, callback) {
    const destination = record.destination === 'rejects' ? this.#rejects : this.#output;

    if (destination.write(record.data)) {
      callback();
      return;
    }

    const onDrain = () => {
      destination.off('error', onError);
      callback();
    };
    const onError = (error) => {
      destination.off('drain', onDrain);
      callback(error);
    };

    destination.once('drain', onDrain);
    destination.once('error', onError);
  }

  _final(callback) {
    this.#output.end();
    this.#rejects.end();

    Promise.all([finished(this.#output), finished(this.#rejects)]).then(
      () => callback(),
      (error) => callback(error),
    );
  }

  _destroy(error, callback) {
    this.#output.off('error', this.#destinationError);
    this.#rejects.off('error', this.#destinationError);
    if (!this.#output.destroyed) this.#output.destroy();
    if (!this.#rejects.destroyed) this.#rejects.destroy();
    callback(error);
  }
}

export async function processLogFile(inputPath, outputPath) {
  const input = createReadStream(inputPath, { highWaterMark: 64 * 1024 });
  await pipeline(input, createLineSplitter(), new LogTransform(), new OutputRouter(outputPath));
}

function usage() {
  return 'Usage: node process-logs.mjs <input> <output>';
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || extra.length > 0) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    processLogFile(inputPath, outputPath).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
