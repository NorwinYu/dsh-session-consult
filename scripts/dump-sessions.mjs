/**
 * Dump stored DSH sessions to plain JSON so the digest can be benchmarked.
 *
 *   node scripts/dump-sessions.mjs --out ./session-dumps
 *   node scripts/dump-sessions.mjs --home "$DSH_HOME" --out ./session-dumps --limit 50
 *
 * Session logs are stored as multi-frame zstd streams (one frame per append
 * batch), so this walks the frames instead of decoding only the first one.
 * Nothing is written outside --out; the session store is opened read-only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseArgs } from 'node:util';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const { values } = parseArgs({
  options: {
    home: { type: 'string', default: process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh') },
    out: { type: 'string', default: path.join(process.cwd(), 'session-dumps') },
    limit: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`usage: node scripts/dump-sessions.mjs [--home <dsh-home>] [--out <dir>] [--limit <n>]`);
  process.exit(0);
}

/** Frame offsets of a multi-frame zstd stream. */
function frameOffsets(buffer) {
  const offsets = [];
  let cursor = 0;
  for (;;) {
    const found = buffer.indexOf(ZSTD_MAGIC, cursor);
    if (found === -1) break;
    offsets.push(found);
    cursor = found + ZSTD_MAGIC.length;
  }
  return offsets;
}

/** Decompress every frame, tolerating a false magic byte sequence. */
export function decompressAll(buffer) {
  const offsets = frameOffsets(buffer);
  if (offsets.length === 0) {
    throw new Error('not a zstd stream: no frame magic found');
  }
  const chunks = [];
  let position = offsets[0];
  while (position < buffer.length) {
    const candidates = offsets.filter((offset) => offset > position).concat(buffer.length);
    let advanced = false;
    for (const end of candidates) {
      try {
        chunks.push(zlib.zstdDecompressSync(buffer.subarray(position, end)));
        position = end;
        advanced = true;
        break;
      } catch {
        /* truncated frame: try a later boundary */
      }
    }
    if (!advanced) break; // torn tail: stop at the last readable frame
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Every stored session log under <home>/sessions. */
function findLogs(root) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) found.push(full);
    }
  };
  walk(path.join(root, 'sessions'), 0);
  return found;
}

const logs = findLogs(values.home).sort();
if (logs.length === 0) {
  console.error(`no stored sessions under ${path.join(values.home, 'sessions')}`);
  process.exit(2);
}

const limit = values.limit === undefined ? logs.length : Number.parseInt(values.limit, 10);
fs.mkdirSync(values.out, { recursive: true });

let written = 0;
for (const log of logs.slice(0, limit)) {
  const id = path.basename(path.dirname(log));
  try {
    const events = decompressAll(fs.readFileSync(log))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    fs.writeFileSync(path.join(values.out, `${id}.json`), JSON.stringify(events));
    written += 1;
  } catch (error) {
    console.error(`skipped ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`wrote ${written}/${Math.min(limit, logs.length)} session dumps to ${values.out}`);
