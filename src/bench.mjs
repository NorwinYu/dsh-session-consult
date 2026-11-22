/**
 * Benchmark the digest over decompressed session dumps.
 *
 *   node scripts/dump-sessions.mjs --out ./session-dumps
 *   node src/bench.mjs ./session-dumps
 *
 * A dump is a JSON array of session events, one file per session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDigest } from './digest.mjs';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('usage: node src/bench.mjs <dir-of-session-dumps>');
  console.error('  produce one with: node scripts/dump-sessions.mjs --out <dir>');
  process.exit(2);
}

const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'));
if (files.length === 0) {
  console.error(`no .json dumps in ${dir}`);
  process.exit(2);
}

const rows = [];

for (const file of files.sort()) {
  const events = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const header = events.find((event) => event.type === 'session') ?? {};
  const title = [...events].reverse().find((event) => event.type === 'session/title')?.data?.title ?? '';
  const started = performance.now();
  const { text, stats } = buildDigest({
    events,
    sessionId: header.id,
    title,
    cwd: header.cwd,
    capturedThroughSeq: events.at(-1)?.seq,
  });
  rows.push({ file, stats, ms: performance.now() - started, text });
}

const pad = (value, width) => String(value).padStart(width);

console.log(
  'session'.padEnd(46),
  pad('events', 7),
  pad('fullTok', 10),
  pad('digestTok', 10),
  pad('ratio', 7),
  pad('textKeep', 9),
  pad('ms', 7),
);

for (const { file, stats, ms } of rows) {
  const fullTok = Math.ceil(stats.sourceChars / 3);
  console.log(
    file.replace(/\.json$/, '').padEnd(46),
    pad(stats.eventCount, 7),
    pad(fullTok, 10),
    pad(stats.approxTokens, 10),
    pad(`${((stats.approxTokens / fullTok) * 100).toFixed(1)}%`, 7),
    pad(`${Math.round(stats.textRetention * 100)}%`, 9),
    pad(ms.toFixed(0), 7),
  );
}

const worst = rows.reduce((a, b) => (b.ms > a.ms ? b : a));
console.log(`\nslowest digest: ${worst.file} ${worst.ms.toFixed(0)}ms`);
