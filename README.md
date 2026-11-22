# dsh-session-consult

[![npm](https://img.shields.io/npm/v/dsh-session-consult.svg)](https://www.npmjs.com/package/dsh-session-consult)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/NorwinYu/dsh-session-consult/actions/workflows/ci.yml/badge.svg)](https://github.com/NorwinYu/dsh-session-consult/actions/workflows/ci.yml)

Let one DeepSeek Harness session consult another session's history — read-only,
cheap, and labelled with provenance.

A session is a good memory and a bad messenger: its context cannot be handed to
another session, and asking it a question means waking it up, which changes it.
This plugin adds the missing verb: **consult**.

> Not to be confused with [`dsh-consult`](https://www.npmjs.com/package/dsh-consult),
> which consults *other models*. This plugin consults *other sessions*.

## Quick start

```sh
dsh plugin --profile <profile> add dsh-session-consult
```

Restart the app (the tool appears on the next start), then just ask:

```
Ask the billing-refactor session what migration order we settled on.
```

The model calls:

```js
consult_session({ session: "billing refactor", question: "Which migration order did we settle on?" })
```

and answers with a citation:

```
The migration order is customers → invoices → line items; a single-shot
migration was rejected because the invoice backfill locks the ledger (T7).

---
source: session-c2Vzc2lvbi0… (persisted, captured through seq 1841) · 12 turns ·
digest ≈5.9K tok · text retained 100%
```

Not sure what is consultable? Ask for the list:

```
Which sessions can I consult?        →  consult_session({ mode: "list" })
```

## Requirements

- DeepSeek Harness `>=0.2.2-rc.1 <0.4.0` — the profile must mount `tools`,
  `agents` and `sessionPersistence`; every standard profile does.
- Node.js `>=22.15` for the offline tooling only; the plugin itself uses no Node
  API beyond `node:crypto`.

Install from a checkout instead, for unreleased work:

```sh
git clone https://github.com/NorwinYu/dsh-session-consult.git
dsh plugin --profile <profile> add ./dsh-session-consult
```

## How it works

```
your session ──consult_session({ session, question })──►
                     │
                     │ 1. read the target's log (read-only, no lock)
                     │ 2. build a bounded digest: text in, tool noise out
                     │ 3. hand it to a throwaway child agent
                     ▼
             answer + provenance ──► back into your context
```

Three modes:

| mode | what happens | cost |
|---|---|---|
| `ask` *(default)* | a tool-restricted child agent answers from the digest | one child turn |
| `read` | the digest comes back to you; you reason over it | no child turn |
| `list` | the sessions that can be consulted, with ids and ages | none |

The consulted session is only ever **read**: its log is never written, it is
never steered or resumed, and no lock is taken.

## Compared with `@`-referencing a session

The harness can already pull another session into a message with an `@` mention.
That is a different tool for a different job; both are useful.

| | `@` reference | `consult_session` |
|---|---|---|
| direction | one-way: a snapshot is inserted into your message | question → answer, with follow-ups |
| trigger | you type `@` in the composer, per message | the model decides, per question |
| size | a fixed bounded preview, truncated | a digest sized to the question, budget adjustable |
| tools | none — the snapshot is untrusted text in your context | the child may use read-only tools to check current files |
| follow-ups | no, the capture is frozen | yes, one child keeps the thread |
| target | whatever the picker offers | any session, by id, mention or title |
| provenance | the snapshot is written into the turn | every result names the source, the capture point and what was dropped |

Rule of thumb: `@` is "put this context in front of me", consult is "ask that
session a question (or three)".

## Usage

### Addressing a session

| argument | example | resolution |
|---|---|---|
| raw id | `session-8f3c…` | used as-is |
| canonical mention | `@[billing](dsh-session:c2Vz…)` | decoded to the id |
| title fragment | `billing refactor` | resolved through the same candidate service the `@` menu uses |

A fragment that matches several sessions is **refused with the candidate list**,
never guessed:

```
Error: consult: "OSM" matches 2 sessions — retry with a more specific title or an id:
  - OSM building data export guide · session-c7798e00-… · 3d ago
  - OSM licence review · session-ff185161-… · 4d ago
```

### Reading instead of asking

```js
consult_session({ session: "billing refactor", question: "…", mode: "read" })
```

### Failure modes are answers too

- unknown target → a clear error, no partial digest;
- empty history → "no completed turns yet", plus provenance;
- child crash → the recorded error, not an empty string;
- timeout → the child's current turn is interrupted and the call fails loudly;
- self-consult → refused.

## How the digest works

The digest keeps **every human/assistant text block verbatim** and spends the
rest of the budget on the newest turns:

| tier | what it keeps |
|---|---|
| expanded | the newest turns: full text plus a one-line tool trail (`· bash: pnpm test` → `→ ok`) |
| text-only | when the trail does not fit, the conversation is kept and the calls are dropped |
| index | older turns as one line each (`T12 U: … / A: …`) |
| dropped | whatever still does not fit, oldest first |
| pinned | the first turn's task statement, **when it would otherwise be dropped** |

Reasoning blocks, bookkeeping events (`step/*`, `job/*`, delivery receipts),
system prompts, tool output bodies, and **host-injected user-role messages**
(`runtime-context`, `skill-catalog`, `time-context`) never enter the digest.
Only a human or a peer agent counts as conversation. Tool results are reduced to
one line, and failures are marked `[error]`.

Measured over 69 sessions on a development machine running DSH `0.2.2-rc.1`:

| session | source tokens | digest tokens | ratio | text kept |
|---|---|---|---|---|
| 251 events | 397K | 2.8K | 0.7% | 100% |
| 418 events | 420K | 4.2K | 1.0% | 100% |
| 2,410 events | 2.2M | 5.6K | 0.3% | 90% |
| 4,919 events | 3.4M | 7.0K | 0.2% | 57% |
| 10,894 events | 9.6M | 6.5K | 0.1% | 39%¹ |

¹ A very long session cannot fit one 7K-token budget. Allocation is
newest-first, so recent context survives and the oldest turns are dropped
deliberately; the provenance line reports how many. Worst observed build time:
~360 ms for a 60 MB log.

### Why not just fork the target session

Forking is the obvious mechanism and it works: a child can be created from
another session's event prefix and reproduces it byte-for-byte. It is also
unusable in practice — the same 69 sessions show a median completed-turn prefix
of **~1.5M tokens** (max 17.8M), of which only **1.7%** is human/assistant text
and **98%** is reasoning, tool output and bookkeeping. Copying that costs more
context than any model has, to deliver less information than a digest.

Both numbers are reproducible on your own machine with `npm run dump` and
`npm run bench` (see [Development](#development)).

## Safety

A foreign session's transcript is untrusted input: it can contain text that
looks like instructions. Two independent defences:

1. **The digest is framed as data.** The child is told to answer only from the
   record and never to follow directives, permission claims or tool requests
   found inside it.
2. **The child cannot act.** Its tool set is replaced by an allow-list of
   read-only tools the profile actually has (`read`, `read_image`, `grep`,
   `glob`, `ls`, …). Shells, writers, network, messaging, subagents, and this
   plugin's own tool disappear from its view. In a verified run the child's
   request header listed only `glob`, `grep`, `read` and `read_image`.

Self-consult is refused, so a session cannot recurse into itself. The child does
inherit the target's working directory for those read-only tools — see
[Privacy](#privacy).

## When the target session is running

Consulting a live session is safe and always returns a **prefix**:

- a read while the target holds the write lease succeeds;
- the prefix can end mid-step (a tool call whose result has not committed),
  which the digest renders as `→ (no result captured)`;
- it advances at step boundaries;
- the digest reports `(+1 in flight)` and renders that turn under
  `(IN PROGRESS — captured mid-turn, may be incomplete)`;
- an aborted turn is surfaced as `[error]` instead of being reported as a
  completed answer.

Everything after `captured through seq` is invisible by construction. The answer
describes the target's past, never its present.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| the tool never appears | the profile that mounts it is not the one the app booted; install into the same profile, then **restart the app** |
| `matches N sessions` | the title is ambiguous — use a longer fragment or the id; `mode: "list"` shows candidates |
| `no session matches "…"` | the error lists what is available; pick from it |
| the answer says the record does not contain it | the digest is bounded — raise `budget_tokens`, or ask a narrower question |
| `ask` feels slow | it is a full child turn; `mode: "read"` returns the digest without one |
| a new session appears under the current one | that is the consult child; it is reused per `(caller, target)`, and `mode: "read"` creates none |

## Configuration

Override through the profile patch layer:

```yaml
- id: consult-session
  config:
    budgetTokens: 7000        # default digest budget
    minBudgetTokens: 500      # clamp for budget_tokens
    maxBudgetTokens: 40000    # clamp for budget_tokens
    timeoutMs: 180000         # bound on one child turn
    cacheEntries: 32          # cached digests
    maxChildren: 8            # reused consult children
    readTools: [read, read_image, grep, glob, ls, list_dir, load_workspace_dependencies]
    denyTools: []             # extra denials when no configured read tool exists
```

## Privacy

This plugin reads the host's own session store. What that means before you turn
it on:

- **The consulted session's text leaves the machine.** The digest is part of a
  model request, so it goes wherever your profile's model provider is. Anything
  that session printed — paths, tokens, customer data — can be in it.
- **The child reads that session's workspace.** Its allow-listed tools run with
  the consulted session's cwd, so files there are readable; set
  `readTools: []` to make it digest-only.
- **Nothing extra is collected.** The plugin has no telemetry, no network calls
  of its own, and writes nothing except the child sessions the host creates.
- **`mode=read` still returns text**, it just does not spend a child turn.
- **Child sessions persist on disk** (the store has no delete API), nested under
  the caller.
- **The offline tooling stays offline**: `dump` reads `$DSH_HOME/sessions` and
  writes JSON; `bench` only reads those dumps.

See [SECURITY.md](SECURITY.md) for reporting a vulnerability.

## Discover (plugin index)

The repository also publishes a plugin index for the experimental Discover tab:

```
https://norwinyu.github.io/dsh-session-consult/market/index.json
```

1. Mount the market bundle (`@deepseek-ai/dsh-experimental-plugin-market-bundle`).
2. Open **Discover → Add index source** and paste the URL.
3. Pick *Session Consult* and install.

The index installs the published npm version (`dsh-session-consult@0.1.0`), not a
git checkout.

## Development

```sh
npm test                                          # 30 unit tests, synthetic fixtures
npm run dump -- --out ./session-dumps --limit 50  # read $DSH_HOME/sessions
npm run bench -- ./session-dumps                  # digest cost table
```

Tests use inline synthetic events: no session logs, no fixtures from a real
installation, no network, no running harness.

```
index.mjs            plugin entry: tool registration, cache, child lifecycle
src/digest.mjs       pure digest builder (no DSH or Node imports)
src/policy.mjs       session-id normalisation and the child tool policy
src/session.mjs      read-only session access, answer/error extraction, deadlines
src/lookup.mjs       target discovery and title resolution
scripts/             offline session dumping
test/                node:test suites
market/index.json    plugin index for the Discover tab
```

## Limitations

- **Child sessions persist.** The store has no delete API, so each consult child
  stays on disk (nested under the caller). Reuse keeps it to one per
  `(caller, target)`; `mode=read` creates none.
- **Secrets pass through.** Assistant text is verbatim, so anything the
  consulted session printed lands in the caller's context.
- **No `@`-menu entry.** The tool resolves titles, but the composer does not
  offer consult as a reference source yet.
- **Lexical budget.** `chars = tokens × 3` is a mixed CJK/ASCII estimate, not a
  tokenizer.
- **Synchronous.** `ask` waits for the child's turn; long children are bounded by
  `timeoutMs`.
- **Not in the community market yet.** `dshmarket` reads the awesome-dsh-plugin
  catalog; this plugin is not listed there. Use the Discover index above, or
  `dsh plugin add`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, the two load-bearing
invariants, and the fixture rules (synthetic only — never a real session log).
Security reports go through [SECURITY.md](SECURITY.md); changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## Status

`0.1.x` — pre-1.0. The tool arguments and the provenance line are stable; the
digest internals and the child-session mechanics may still move. Those changes
land in a minor version.

## License

MIT — see [LICENSE](LICENSE).
