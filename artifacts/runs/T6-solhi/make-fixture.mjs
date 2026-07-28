#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MIB = 1024 * 1024;
const FILE_CHUNK = 64 * 1024;
const LEVELS = ['debug', 'info', 'warn', 'error'];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

export async function makeFixture(outputPath, sizeMB = 200, seed = 0x5eed1234) {
  if (!Number.isFinite(sizeMB) || sizeMB < 10) {
    throw new RangeError('sizeMB must be at least 10 so the fixture can contain an 8 MiB line');
  }

  const targetBytes = Math.floor(sizeMB * MIB);
  const output = createWriteStream(outputPath);
  const random = seededRandom(seed);
  let bytes = 0;
  let inputLines = 0;
  let validLines = 0;
  let debugLines = 0;
  let rejectedLines = 0;
  let emittedLines = 0;
  let order = 0;
  const rejectLineNumbers = [];

  async function writeRaw(raw, eol = '\n', valid = true, level = undefined) {
    const data = `${raw}${eol}`;
    if (!output.write(data)) await once(output, 'drain');
    bytes += Buffer.byteLength(data);
    inputLines += 1;
    if (valid) {
      validLines += 1;
      if (level === 'debug') debugLines += 1;
      else emittedLines += 1;
    } else {
      rejectedLines += 1;
      rejectLineNumbers.push(inputLines);
    }
  }

  async function writeEntry(entry, eol = '\n') {
    await writeRaw(JSON.stringify(entry), eol, true, entry.level);
  }

  function nextOrder() {
    order += 1;
    return order;
  }

  try {
    await writeEntry({
      ts: 1_700_000_000_001,
      level: 'info',
      msg: 'fixture start Bearer alpha.Token-1',
      reqId: 'req-a',
      order: nextOrder(),
      marker: 'start',
    });
    await writeEntry({
      ts: 1_700_000_000_002,
      level: 'debug',
      msg: 'dropped Bearer debug.Secret',
      reqId: 'req-a',
      order: nextOrder(),
      marker: 'debug',
    }, '\r\n');
    await writeRaw('{"ts":broken,"marker":"malformed-start"}', '\n', false);
    await writeEntry({
      ts: 1_700_000_000_003,
      level: 'warn',
      msg: 'after malformed',
      reqId: 'req-a',
      order: nextOrder(),
      marker: 'after-malformed',
    });
    await writeEntry({
      ts: 1_700_000_000_004,
      level: 'error',
      msg: 'CRLF record',
      reqId: 'req-b',
      order: nextOrder(),
      marker: 'crlf',
    }, '\r\n');

    const boundaryToken = 'Bearer boundary.Token-9';
    const boundaryEntry = {
      ts: 1_700_000_000_005,
      level: 'info',
      msg: boundaryToken,
      reqId: 'req-boundary',
      order: nextOrder(),
      marker: 'boundary',
    };
    const boundaryBase = JSON.stringify(boundaryEntry);
    const baseTokenEnd = boundaryBase.indexOf(boundaryToken) + boundaryToken.length;
    let tokenEndOffset = Math.ceil((bytes + baseTokenEnd) / FILE_CHUNK) * FILE_CHUNK;
    if (tokenEndOffset === bytes + baseTokenEnd) tokenEndOffset += FILE_CHUNK;
    const fillerLength = tokenEndOffset - bytes - baseTokenEnd;
    boundaryEntry.msg = `${'x'.repeat(fillerLength)}${boundaryToken}`;
    const boundaryRaw = JSON.stringify(boundaryEntry);
    const actualTokenEnd = bytes + boundaryRaw.indexOf(boundaryToken) + boundaryToken.length;
    if (actualTokenEnd !== tokenEndOffset || actualTokenEnd % FILE_CHUNK !== 0) {
      throw new Error('failed to align boundary token');
    }
    await writeRaw(boundaryRaw, '\n', true, boundaryEntry.level);

    const hugeMessage = 'H'.repeat(8 * MIB + 257);
    const hugeEntry = {
      ts: 1_700_000_000_006,
      level: 'error',
      msg: hugeMessage,
      reqId: 'req-huge',
      order: nextOrder(),
      marker: 'huge',
    };
    const hugeRaw = JSON.stringify(hugeEntry);
    if (Buffer.byteLength(hugeRaw) <= 8 * MIB) {
      throw new Error('huge fixture line is not larger than 8 MiB');
    }
    await writeRaw(hugeRaw, '\r\n', true, hugeEntry.level);
    await writeRaw('{"ts":1700000000007,"level":"warn","msg":', '\r\n', false);
    await writeRaw('null', '\n', false);

    let generated = 0;
    while (targetBytes - bytes > 2_048) {
      generated += 1;
      if (generated % 4_000 === 0) {
        await writeRaw(`{"ts":oops,"marker":"malformed-${generated}"}`, generated % 8_000 === 0 ? '\r\n' : '\n', false);
        continue;
      }

      const level = LEVELS[Math.floor(random() * LEVELS.length)];
      const reqId = `req-${Math.floor(random() * 128)}`;
      const messageLength = 600 + Math.floor(random() * 900);
      const credential = generated % 97 === 0 ? ' Bearer seeded.Token_2-3' : '';
      const entry = {
        ts: 1_700_000_100_000 + generated,
        level,
        msg: `${'m'.repeat(messageLength)}${credential}`,
        reqId,
        order: nextOrder(),
      };
      const eol = generated % 7 === 0 ? '\r\n' : '\n';
      const dataLength = Buffer.byteLength(JSON.stringify(entry)) + Buffer.byteLength(eol);
      if (dataLength > targetBytes - bytes) break;
      await writeEntry(entry, eol);
    }

    const remaining = targetBytes - bytes;
    if (remaining > 0) {
      // An exact-size malformed tail also exercises a missing trailing newline.
      const tail = remaining === 1 ? '!' : `!${'p'.repeat(remaining - 1)}`;
      if (!output.write(tail)) await once(output, 'drain');
      bytes += Buffer.byteLength(tail);
      inputLines += 1;
      rejectedLines += 1;
      rejectLineNumbers.push(inputLines);
    }

    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }

  return {
    bytes,
    targetBytes,
    inputLines,
    validLines,
    debugLines,
    emittedLines,
    rejectedLines,
    rejectLineNumbers,
    seed: seed >>> 0,
  };
}

function usage() {
  return 'Usage: node make-fixture.mjs [output=fixture.ndjson] [sizeMB=200] [seed]';
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [outputPath = 'fixture.ndjson', sizeArg = '200', seedArg, ...extra] = process.argv.slice(2);
  const sizeMB = Number(sizeArg);
  const seed = seedArg === undefined ? 0x5eed1234 : Number(seedArg);

  if (extra.length > 0 || !Number.isFinite(sizeMB) || !Number.isInteger(seed)) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    makeFixture(outputPath, sizeMB, seed).then(
      (stats) => console.log(JSON.stringify(stats)),
      (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
  }
}
