#!/usr/bin/env node
// Generates a deterministic NDJSON log fixture of roughly a target size,
// including the adversarial shapes the pipeline has to survive.
//
//   node make-fixture.mjs <output> [sizeMB=200] [seed=1]

import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

// mulberry32: small, seeded, reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEVELS = ['debug', 'info', 'warn', 'error'];
const WORDS = [
  'request', 'handled', 'upstream', 'timeout', 'retry', 'cache', 'miss',
  'user', 'session', 'token', 'queue', 'flush', 'shard', 'latency',
];
const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-';

/**
 * Counts of every adversarial shape emitted, so tests can assert exactly.
 * `huge` lines are >8MB, far larger than the 64KB read chunk.
 */
export const PLAN = {
  huge: 2,
  hugeBytes: 9 * 1024 * 1024,
  malformed: 5,
  // Lines whose msg ends in a bearer token, padded so the token lands near a
  // 64KB read-chunk boundary; exercises redaction across a split line.
  boundary: 8,
  chunk: 64 * 1024,
};

function token(rand, len = 40) {
  let s = '';
  for (let i = 0; i < len; i++) s += TOKEN_CHARS[(rand() * TOKEN_CHARS.length) | 0];
  return s;
}

function sentence(rand, n) {
  const w = [];
  for (let i = 0; i < n; i++) w.push(WORDS[(rand() * WORDS.length) | 0]);
  return w.join(' ');
}

/**
 * Yields the fixture as strings. Every line is terminated with "\n" except the
 * very last, which is deliberately left without a trailing newline. Roughly
 * every fifth line uses CRLF.
 */
export function* generate(targetBytes, seed = 1) {
  const rand = rng(seed);
  let bytes = 0;
  let n = 0;
  let pending = null; // held back so the final line can omit its terminator

  const emit = function* (line, crlf) {
    const s = line + (crlf ? '\r\n' : '\n');
    if (pending !== null) yield pending;
    pending = s;
    bytes += Buffer.byteLength(s);
  };

  // Front-load the adversarial lines so a small fixture still contains them all.
  for (let i = 0; i < PLAN.malformed; i++) {
    yield* emit(['{"ts": 1, "level": "info"', 'not json at all', '[1,2,3]',
      '{"ts":2,"level":"info","msg":"x"}}', '{'][i % 5], false);
  }
  for (let i = 0; i < PLAN.huge; i++) {
    const pad = 'x'.repeat(PLAN.hugeBytes);
    yield* emit(JSON.stringify({
      ts: 1700000000000 + n, level: 'error', reqId: `huge-${i}`,
      msg: `${pad} Bearer ${token(rand)}`,
    }), i % 2 === 1);
    n++;
  }
  for (let i = 0; i < PLAN.boundary; i++) {
    // Pad so that the token sits just past a read-chunk boundary.
    const tok = token(rand);
    const head = `{"ts":${1700000000000 + n},"level":"warn","reqId":"edge-${i}","msg":"`;
    const tail = ` Bearer ${tok}"}`;
    const pad = Math.max(1, PLAN.chunk - ((bytes + head.length + tail.length) % PLAN.chunk));
    yield* emit(head + 'p'.repeat(pad) + tail, false);
    n++;
  }

  const reqIds = Array.from({ length: 512 }, (_, i) => `req-${i}`);
  while (bytes < targetBytes) {
    const level = LEVELS[(rand() * LEVELS.length) | 0];
    const rec = {
      ts: 1700000000000 + n,
      level,
      msg: sentence(rand, 4 + ((rand() * 12) | 0)),
    };
    if (rand() < 0.3) rec.msg += ` Bearer ${token(rand)}`;
    if (rand() < 0.7) rec.reqId = reqIds[(rand() * reqIds.length) | 0];
    yield* emit(JSON.stringify(rec), n % 5 === 0);
    n++;
  }
  if (pending !== null) yield pending.replace(/\r?\n$/, '');
}

export async function writeFixture(path, targetBytes, seed = 1) {
  const out = createWriteStream(path);
  for (const s of generate(targetBytes, seed)) {
    if (!out.write(s)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, mb = '200', seed = '1'] = process.argv.slice(2);
  if (!path) {
    console.error('usage: node make-fixture.mjs <output> [sizeMB=200] [seed=1]');
    process.exit(2);
  }
  await writeFixture(path, Number(mb) * 1024 * 1024, Number(seed));
  console.error(`wrote ${path} (~${mb}MB, seed ${seed})`);
}
