import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MUTATING_TOOLS,
  buildToolRestriction,
  normalizeSessionId,
} from '../src/policy.mjs';
import { finalAnswer, turnFailure, withDeadline } from '../src/session.mjs';

const EVERYTHING = ['read', 'grep', 'glob', 'bash', 'edit', 'web_fetch', 'send_message'];
const knownIn = (names) => (name) => names.includes(name);

test('normalizeSessionId round-trips canonical mentions', () => {
  const id = 'session-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
  const encoded = Buffer.from(id).toString('base64url');
  assert.equal(normalizeSessionId(`dsh-session:${encoded}`), id);
  assert.equal(normalizeSessionId(`@[a title](dsh-session:${encoded})`), id);
  assert.equal(normalizeSessionId(id), id);
  assert.equal(normalizeSessionId(`  ${id}  `), id);
});

test('normalizeSessionId leaves non-canonical input alone', () => {
  assert.equal(normalizeSessionId('plain-id'), 'plain-id');
  assert.equal(normalizeSessionId(''), '');
  assert.equal(normalizeSessionId(undefined), '');
  assert.equal(normalizeSessionId('@[broken](dsh-session:abc'), '@[broken](dsh-session:abc');
});

test('restriction prefers an allow-list of known read-only tools', () => {
  const filter = buildToolRestriction({
    known: knownIn(EVERYTHING),
    readTools: ['read', 'grep', 'glob', 'ghost'],
  });
  assert.deepEqual(filter, { allow: ['read', 'grep', 'glob'] });
});

test('restriction falls back to denying mutating tools when no read tool exists', () => {
  const filter = buildToolRestriction({
    known: knownIn(['bash', 'edit', 'custom']),
    readTools: ['read', 'grep'],
    denyTools: ['custom'],
  });
  assert.deepEqual(filter, { deny: ['bash', 'edit', 'custom'] });
});

test('restriction returns undefined when nothing is known', () => {
  assert.equal(buildToolRestriction({ known: () => false, readTools: ['read'] }), undefined);
});

test('the mutating set never contains a read-only tool', () => {
  for (const name of ['read', 'grep', 'glob', 'list_dir']) {
    assert.ok(!MUTATING_TOOLS.includes(name), `${name} must stay available to a consult child`);
  }
});

const message = (seq, text) => ({
  type: 'assistant/message',
  seq,
  data: { message: { content: [{ type: 'text', text }] } },
});
const fakeSession = (events) => ({ snapshotEvents: () => events });

test('finalAnswer only reads events after the requested sequence', () => {
  const session = fakeSession([message(1, 'old'), message(5, 'new'), message(6, 'newer')]);
  assert.equal(finalAnswer(session, 5), 'new\nnewer');
  assert.equal(finalAnswer(session, 7), '');
});

test('turnFailure reports the first error turn', () => {
  const session = fakeSession([
    { type: 'turn/end', seq: 3, data: { reason: { kind: 'error', error: { message: 'boom', code: 'X' } } } },
  ]);
  assert.deepEqual(turnFailure(session, 0), { message: 'boom', code: 'X' });
  assert.equal(turnFailure(session, 4), undefined);
});

test('turnFailure reports an aborted turn', () => {
  const session = fakeSession([{ type: 'turn/end', seq: 1, data: { reason: { kind: 'aborted' } } }]);
  assert.deepEqual(turnFailure(session, 0), { message: 'the consult turn was aborted' });
});

test('withDeadline rejects and fires the abort callback on timeout', async () => {
  let aborted = false;
  await assert.rejects(
    withDeadline(new Promise(() => {}), 10, () => {
      aborted = true;
    }),
    /did not finish within 10ms/,
  );
  assert.equal(aborted, true);
});

test('withDeadline resolves fast work and clears the timer', async () => {
  assert.equal(await withDeadline(Promise.resolve('ok'), 1000), 'ok');
});

// ---- lookup ----------------------------------------------------------------

import { discoverSessions, formatCandidates, looksLikeSessionId, relativeAge, resolveSessionId } from '../src/lookup.mjs';

test('looksLikeSessionId accepts ids and rejects titles', () => {
  assert.equal(looksLikeSessionId('session-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'), true);
  assert.equal(looksLikeSessionId('0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'), true);
  assert.equal(looksLikeSessionId('billing refactor'), false);
  assert.equal(looksLikeSessionId('session'), false);
});

test('discoverSessions prefers the reference resolver', async () => {
  const resolver = {
    listCandidates: async (_agent, query, limit) =>
      [{ sessionId: 'session-a', label: 'A', displayTitle: 'Billing', cwd: '/w' },
       { sessionId: 'session-b', label: 'B' }].slice(0, limit),
  };
  const found = await discoverSessions({ resolver, agent: { id: 'self' } }, 'bill', 5);
  assert.deepEqual(found.map((f) => f.id), ['session-a', 'session-b']);
  assert.equal(found[0].title, 'Billing');
});

test('discoverSessions falls back to ids when no resolver is mounted', async () => {
  const sessionQuery = {
    listSessions: async () => [
      { header: { id: 'session-x', cwd: '/a' } },
      { header: { id: 'session-y', cwd: '/b' } },
      { header: { id: 'self', cwd: '/a' } },
    ],
  };
  const found = await discoverSessions({ sessionQuery, agent: { id: 'self' } }, 'session-y', 5);
  assert.deepEqual(found.map((f) => f.id), ['session-y']);
});

test('resolveSessionId passes ids through and resolves a unique title', async () => {
  const services = {
    resolver: {
      listCandidates: async (_agent, query) =>
        query === 'billing' ? [{ sessionId: 'session-a', label: 'billing refactor' }] : [],
    },
  };
  assert.equal(await resolveSessionId(services, 'session-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'), 'session-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b');
  assert.equal(await resolveSessionId(services, 'billing'), 'session-a');
});

test('resolveSessionId reports ambiguous and missing targets', async () => {
  const resolver = {
    listCandidates: async (_agent, query) =>
      query === 'refactor'
        ? [{ sessionId: 'session-a', label: 'refactor A' }, { sessionId: 'session-b', label: 'refactor B' }]
        : [],
  };
  await assert.rejects(resolveSessionId({ resolver }, 'refactor'), /matches 2 sessions/);
  await assert.rejects(resolveSessionId({ resolver }, 'ghost'), /no session matches/);
});

test('formatCandidates renders titles, ids and age', () => {
  const rendered = formatCandidates(
    [{ id: 'session-a', title: 'Billing', createdAt: 1_700_000_000_000 }, { id: 'session-b', title: '' }],
    { now: 1_700_000_120_000 },
  );
  assert.match(rendered, /- Billing · session-a · 2m ago/);
  assert.match(rendered, /- \(untitled\) · session-b/);
  assert.equal(relativeAge(90_000), '2m ago');
});
