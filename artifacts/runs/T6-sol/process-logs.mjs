#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs';
import { finished, pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';

const TOKEN = /Bearer [A-Za-z0-9._-]+/g;

export class LineSplitter extends Transform {
  constructor(options = {}) {
    super({ ...options, readableObjectMode: true });
    this.parts = [];
    this.length = 0;
    this.lineNumber = 0;
  }

  _transform(chunk, encoding, callback) {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] !== 0x0a) continue;
        this.#append(buffer.subarray(start, i));
        this.#emitLine();
        start = i + 1;
      }
      if (start < buffer.length) this.#append(buffer.subarray(start));
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      if (this.length > 0) this.#emitLine();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  #append(part) {
    if (part.length === 0) return;
    this.parts.push(part);
    this.length += part.length;
  }

  #emitLine() {
    let line;
    if (this.parts.length === 0) {
      line = '';
    } else if (this.parts.length === 1) {
      line = this.parts[0].toString('utf8');
    } else {
      line = Buffer.concat(this.parts, this.length).toString('utf8');
    }
    if (line.endsWith('\r')) line = line.slice(0, -1);
    this.parts = [];
    this.length = 0;
    this.lineNumber += 1;
    this.push({ lineNumber: this.lineNumber, line });
  }
}

class LogProcessor extends Transform {
  constructor(rejects) {
    super({ writableObjectMode: true });
    this.rejects = rejects;
    this.sequences = new Map();
  }

  _transform({ lineNumber, line }, _encoding, callback) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      const reject = `${JSON.stringify({ line: lineNumber, raw: line, error: error.message })}\n`;
      if (this.rejects.write(reject)) callback();
      else this.rejects.once('drain', callback);
      return;
    }

    if (record.level === 'debug') {
      callback();
      return;
    }

    if (typeof record.msg === 'string') record.msg = record.msg.replace(TOKEN, 'Bearer [REDACTED]');
    if (Object.prototype.hasOwnProperty.call(record, 'reqId')) {
      const next = (this.sequences.get(record.reqId) ?? 0) + 1;
      this.sequences.set(record.reqId, next);
      record.seq = next;
    }

    callback(null, `${JSON.stringify(record)}\n`);
  }
}

export async function processLogs(inputPath, outputPath, options = {}) {
  const rejectsPath = `${outputPath}.rejects`;
  const input = createReadStream(inputPath, { highWaterMark: options.highWaterMark ?? 64 * 1024 });
  const output = createWriteStream(outputPath);
  const rejects = createWriteStream(rejectsPath);
  const processor = new LogProcessor(rejects);
  const rejectFailure = new Promise((_, reject) => {
    rejects.once('error', (error) => {
      processor.destroy(error);
      reject(error);
    });
  });

  try {
    await Promise.race([
      pipeline(input, new LineSplitter(), processor, output),
      rejectFailure,
    ]);
    rejects.end();
    await finished(rejects);
  } catch (error) {
    input.destroy();
    output.destroy();
    rejects.destroy();
    throw error;
  }

  return { outputPath, rejectsPath };
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node process-logs.mjs <input> <output>');
    process.exitCode = 2;
    return;
  }
  await processLogs(inputPath, outputPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
