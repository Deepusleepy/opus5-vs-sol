#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const MIB = 1024 * 1024;
const READ_CHUNK = 64 * 1024;

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function parseArguments(argv) {
  const options = { output: 'fixture.ndjson', sizeMB: 200, seed: 0x5eed1234 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') options.output = argv[++i];
    else if (arg === '--size-mb') options.sizeMB = Number(argv[++i]);
    else if (arg === '--seed') options.seed = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.sizeMB) || options.sizeMB <= 0) throw new Error('--size-mb must be positive');
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');
  return options;
}

export async function makeFixture(outputPath, { sizeMB = 200, seed = 0x5eed1234 } = {}) {
  const targetBytes = Math.floor(sizeMB * MIB);
  const stream = createWriteStream(outputPath);
  let bytes = 0;

  async function write(data) {
    bytes += Buffer.byteLength(data);
    if (!stream.write(data)) await once(stream, 'drain');
  }

  function encode(record, ending = '\n') {
    return `${JSON.stringify(record)}${ending}`;
  }

  await write(encode({ ts: 1, level: 'info', msg: 'fixture-start Bearer alpha.1', reqId: 'req-A' }, '\r\n'));
  await write(encode({ ts: 2, level: 'debug', msg: 'drop-me', reqId: 'req-A' }));
  await write(encode({ ts: 3, level: 'warn', msg: 'fixture-second', reqId: 'req-A' }, '\r\n'));
  await write('{ definitely not json\r\n');

  const hugeMessage = `huge-start ${'x'.repeat(9 * MIB)} Bearer huge_secret huge-end`;
  await write(encode({ ts: 4, level: 'error', msg: hugeMessage, reqId: 'huge' }));

  const boundaryBase = { ts: 5, level: 'info', msg: '', reqId: 'boundary' };
  const token = 'Bearer boundary-token_7';
  boundaryBase.msg = token;
  const withoutPadding = JSON.stringify(boundaryBase);
  const tokenEndInRecord = withoutPadding.indexOf(token) + token.length;
  const paddingLength = (READ_CHUNK - ((bytes + tokenEndInRecord) % READ_CHUNK)) % READ_CHUNK;
  boundaryBase.msg = `${'p'.repeat(paddingLength)}${token}`;
  const boundaryLine = encode(boundaryBase);
  const tokenEndOffset = bytes + boundaryLine.indexOf(token) + token.length;
  if (tokenEndOffset % READ_CHUNK !== 0) throw new Error('failed to align boundary token');
  await write(boundaryLine);

  const random = randomGenerator(seed);
  const levels = ['debug', 'info', 'warn', 'error'];
  let index = 0;
  while (bytes < targetBytes) {
    index += 1;
    if (index % 9973 === 0) {
      await write(`malformed-${index}{\n`);
      continue;
    }
    const level = levels[Math.floor(random() * levels.length)];
    const reqId = `req-${Math.floor(random() * 2048)}`;
    const payloadLength = 256 + Math.floor(random() * 1536);
    const marker = index % 4093 === 0 ? ' Bearer generated.token-1' : '';
    const record = {
      ts: 1_700_000_000_000 + index,
      level,
      msg: `entry-${String(index).padStart(8, '0')} ${'z'.repeat(payloadLength)}${marker}`,
      reqId,
    };
    await write(encode(record, index % 11 === 0 ? '\r\n' : '\n'));
  }

  // Exercise a final record without a trailing newline.
  await write(JSON.stringify({ ts: 9_999_999, level: 'error', msg: 'fixture-end Bearer omega', reqId: 'final' }));
  stream.end();
  await once(stream, 'close');
  return { bytes, targetBytes, seed };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await makeFixture(options.output, options);
  console.log(JSON.stringify({ output: options.output, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
