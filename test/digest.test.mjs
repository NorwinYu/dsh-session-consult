import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDigest,
  groupTurns,
  textBlocks,
  callLine,
  looksLikeError,
} from '../src/digest.mjs';
import { normalizeSessionId } from '../src/policy.mjs';

const text = (t) => ({ type: 'text', text: t });

/** Minimal synthetic session: n turns, each with a user msg, a note, and a bash call. */
function fixture(turns, { result = 'ok', inFlight = false, reasoning = false } = {}) {
  const events = [{ type: 'session', seq: null, data: { id: 's1' } }];
  let seq = 0;
  for (let i = 1; i <= turns; i += 1) {
    events.push({ type: 'turn/start', seq: seq++, time: 1_700_000_000_000, data: { turn: i } });
    events.push({ type: 'user/message', seq: seq++, data: { content: [text(`question ${i}`)], source: { kind: 'user' } } });
    events.push({
      type: 'assistant/message',
      seq: seq++,
      data: {
        message: {
          content: [
            ...(reasoning ? [{ type: 'reasoning', text: 'THINKING '.repeat(500) }] : []),
            text(`answer ${i}`),
          ],
        },
      },
    });
    events.push({
      type: 'tool/call',
      seq: seq++,
      data: { name: 'bash', callId: `c${i}`, arguments: JSON.stringify({ command: `run ${i}` }) },
    });
    if (!inFlight || i < turns) {
      events.push({
        type: 'tool/result',
        seq: seq++,
        data: { toolCallId: `c${i}`, message: { content: [text(result)] } },
      });
      events.push({ type: 'turn/end', seq: seq++, data: { reason: { kind: 'completed' } } });
    }
  }
  return events;
}

test('textBlocks keeps text and drops reasoning/tool-call blocks', () => {
  const blocks = [text('a'), { type: 'reasoning', text: 'r' }, { type: 'tool-call', name: 'x' }, text('b')];
  assert.deepEqual(textBlocks(blocks), ['a', 'b']);
});

test('groupTurns marks an unterminated turn as in flight', () => {
  const turns = groupTurns(fixture(2, { inFlight: true }));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].end, 'completed');
  assert.equal(turns[1].end, undefined);
});

test('callLine prefers command over other arguments', () => {
  assert.equal(callLine({ name: 'bash', arguments: '{"command":"ls -la","description":"x"}' }), '· bash: ls -la');
});

test('looksLikeError detects failing output', () => {
  assert.equal(looksLikeError('Error: boom'), true);
  assert.equal(looksLikeError('exit code 2'), true);
  assert.equal(looksLikeError('all good'), false);
});

test('digest keeps every text block of a small session', () => {
  const events = fixture(3);
  const { text: out, stats } = buildDigest({ events, sessionId: 's1', now: 1_700_000_001_000 });
  for (let i = 1; i <= 3; i += 1) {
    assert.match(out, new RegExp(`question ${i}`));
    assert.match(out, new RegExp(`answer ${i}`));
  }
  assert.equal(stats.turns, 3);
  assert.equal(stats.textRetention, 1);
  assert.equal(stats.inFlightTurns, 0);
});

test('digest never exceeds the budget', () => {
  const events = fixture(40);
  const { text: out } = buildDigest({ events, budgetChars: 4000 });
  assert.ok(out.length <= 4200, `digest ${out.length} chars`);
});

test('digest prioritises the newest turns under a tight budget', () => {
  const events = fixture(60);
  const { text: out, stats } = buildDigest({ events, budgetChars: 600 });
  assert.match(out, /question 60/);
  assert.ok(stats.droppedOldest > 0, 'older turns are dropped');
  assert.ok(stats.expandedTurns < 10, 'only the newest turns are verbatim');
  assert.match(out, /question 1/, 'the task statement survives');
});

test('digest renders an in-flight turn under an explicit heading', () => {
  const events = fixture(2, { inFlight: true });
  const { text: out, stats } = buildDigest({ events });
  assert.equal(stats.inFlightTurns, 1);
  assert.match(out, /IN PROGRESS/);
  assert.match(out, /question 2/);
});

test('digest handles an empty session', () => {
  const { text: out, stats } = buildDigest({ events: [] });
  assert.match(out, /Consulted session/);
  assert.equal(stats.turns, 0);
  assert.equal(stats.textRetention, 1);
});

test('reasoning bulk does not reach the digest', () => {
  const events = fixture(2, { reasoning: true });
  const { text: out } = buildDigest({ events });
  assert.ok(!out.includes('THINKING'), 'reasoning text is dropped');
});

test('errors in tool results are marked', () => {
  const events = fixture(1, { result: 'Error: file missing' });
  const { text: out } = buildDigest({ events });
  assert.match(out, /\[error\]/);
});


test('host-injected user messages are not treated as conversation', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [text('real question')], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { content: [text('Current runtime context. BOILERPLATE')], source: { kind: 'runtime-context' } } },
    { type: 'user/message', seq: 3, data: { content: [text('<system-reminder> SKILLS')], source: { kind: 'skill-catalog' } } },
    { type: 'user/message', seq: 4, data: { content: [text('Time sampled BOILERPLATE')], source: { kind: 'time-context' } } },
    { type: 'assistant/message', seq: 5, data: { message: { content: [text('answer')] } } },
    { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } },
  ];
  const { text: out } = buildDigest({ events });
  assert.match(out, /real question/);
  assert.doesNotMatch(out, /BOILERPLATE/);
  assert.doesNotMatch(out, /system-reminder/);
});

test('a long tool trail is dropped before the conversation text', () => {
  const events = fixture(1);
  // add 40 tool calls with long arguments to the single turn
  const turnStart = events.findIndex((e) => e.type === 'turn/start');
  const extra = Array.from({ length: 40 }, (_, i) => ({
    type: 'tool/call',
    seq: 100 + i,
    data: { name: 'bash', callId: `x${i}`, arguments: JSON.stringify({ command: 'echo ' + 'x'.repeat(120) }) },
  }));
  events.splice(turnStart + 1, 0, ...extra);
  const { text: out, stats } = buildDigest({ events, budgetChars: 1200 });
  assert.equal(stats.textOnlyTurns, 1, 'the tool trail is dropped, the text kept');
  assert.equal(stats.expandedTurns, 0);
  assert.match(out, /question 1/);
  assert.match(out, /answer 1/);
});
