# Contributing

Thanks for taking a look. This is a small plugin; the rules below keep it small.

## Setup

No dependencies, no build step:

```sh
git clone https://github.com/NorwinYu/dsh-session-consult.git
cd dsh-session-consult
npm test
```

Node.js `>=22.15` (the offline tooling uses `zlib.zstdDecompressSync`).

## Layout

| path | responsibility |
|---|---|
| `index.mjs` | plugin entry: tool registration, digest cache, child lifecycle, config |
| `src/digest.mjs` | pure digest builder — **must not import DSH or Node APIs** so it stays testable offline |
| `src/policy.mjs` | session-id normalisation and the child tool policy — no DSH imports |
| `src/session.mjs` | read-only session access, answer/error extraction, deadlines |
| `src/lookup.mjs` | target discovery and title resolution |
| `scripts/dump-sessions.mjs` | offline session export (multi-frame zstd) |
| `src/bench.mjs` | digest cost table over exported sessions |
| `test/` | `node:test` suites |

Two invariants are load-bearing:

- `src/digest.mjs` and `src/policy.mjs` stay free of DSH and Node dependencies.
  A host profile may not resolve `@deepseek-ai/*` from the plugin's directory.
- The plugin never writes to a consulted session. Read-only access is the
  product, not an implementation detail.

## Fixtures are synthetic

**Never commit a real session log, a real session id, or a path from your
machine.** Tests build events inline:

```js
const events = [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1, data: { content: [text('question')], source: { kind: 'user' } } },
  { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
];
```

Session ids in tests are visibly fake (`session-0f1e2d3c-…`). Benchmarks may
report aggregate numbers from a real installation, but never content, titles or
ids.

## Checks

```sh
npm test
node --check index.mjs src/*.mjs scripts/*.mjs   # syntax, no bundler
```

A change to the digest should come with:

- a test that fails on the old behaviour;
- the bench table in `README.md` refreshed if the cost profile moved;
- the Chinese README updated in the same commit (the two files are kept in sync).

## Commits and pull requests

- One concern per commit; the subject line states the user-visible effect.
- Describe *why* in the body — the code already says what.
- If you touched behaviour, say what you ran to verify it, including the model
  and profile if a live run was involved.
- No session logs, screenshots of private sessions, or absolute paths in the
  diff.
