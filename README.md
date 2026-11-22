# dsh-session-consult

[![npm](https://img.shields.io/npm/v/dsh-session-consult.svg)](https://www.npmjs.com/package/dsh-session-consult)

Let one DeepSeek Harness session consult another session's history — read-only,
cheap, and labelled with provenance.

A session is a good memory and a bad messenger: its context cannot be handed to
another session, and asking it a question means waking it up, which changes it.
This plugin adds the missing verb: **consult**.

```js
consult_session({ session, question })                // ask: a restricted child answers
consult_session({ session, question, mode: "read" })  // read: return the digest itself
consult_session({ mode: "list" })                     // discover what can be consulted
```

The consulted session is only ever **read**: its log is never written, it is
never steered or resumed, and no lock is taken.

> Not to be confused with [`dsh-consult`](https://www.npmjs.com/package/dsh-consult),
> which consults *other models*. This plugin consults *other sessions*.

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

## Status

`0.1.x` — pre-1.0. The tool arguments and the provenance line are stable; the
digest internals and the child-session mechanics may still move. Those changes
land in a minor version and in [CHANGELOG.md](CHANGELOG.md).

## Why not just fork the target session

Forking is the obvious mechanism and it works: a child can be created from
another session's event prefix and reproduces it byte-for-byte. It is also
unusable in practice.

Measured over 69 sessions on a development machine running DSH `0.2.2-rc.1`:

| metric | median | max |
|---|---|---|
| full completed-turn prefix (what a fork copies) | **~1.5M tokens** | 17.8M |
| of which user + assistant text | **1.7%** | — |
| of which reasoning, tool output, bookkeeping | **98%** | — |

A real session is mostly tool output and internal reasoning. Copying it costs
more context than any model has, to deliver less information than a digest.
Both numbers are reproducible on your own machine with `npm run dump` and
`npm run bench` (see [Development](#development)).

## Requirements

- DeepSeek Harness `>=0.2.2-rc.1 <0.4.0` (the profile must mount `tools`,
  `agents` and `sessionPersistence`; every standard profile does).
- Node.js `>=22.15` for the offline tooling only; the plugin itself uses no
  Node API beyond `node:crypto`.

## Install

```sh
dsh plugin --profile <profile> add dsh-session-consult
```

From a checkout, for unreleased work:

```sh
git clone https://github.com/NorwinYu/dsh-session-consult.git
dsh plugin --profile <profile> add ./dsh-session-consult
```

The package ships `cordis.patch.yml`, so installation also inserts the plugin
row. To try it without touching a profile, patch one at boot:

```yaml
# extra.yml — the package must be resolvable by the profile
- insert:
    - id: consult-session
      name: dsh-session-consult
```

```sh
dsh --profile <profile> --patch ./extra.yml
```

Installing changes the composed profile: restart the running app (or start a new
session) to see the tool.

### Install from Discover (plugin index)

The repository publishes a plugin index for the experimental Discover tab:

```
https://norwinyu.github.io/dsh-session-consult/market/index.json
```

1. Mount the market bundle (`@deepseek-ai/dsh-experimental-plugin-market-bundle`).
2. Open **Discover → Add index source** and paste the URL.
3. Pick *Session Consult* and install.

`market/index.json` pins an exact commit per version, so what Discover installs
is exactly what this repository contains at that commit.

## Usage

Ask another session what it decided:

```js
consult_session({
  session: "@[billing refactor](dsh-session:c2Vzc2lvbi0...)",
  question: "Which migration order did we settle on, and what was rejected?",
})
```

Return the digest instead of paying for a child turn:

```js
consult_session({ session: "billing refactor", question: "…", mode: "read" })
```

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

Discover what is available with `mode: "list"` (optionally filtered by the same
fragment).

### What comes back

Every result ends with provenance, so the caller can judge and cite it:

```
The migration order is customers → invoices → line items. The team rejected a
single-shot migration because the invoice backfill locked the ledger table (T7).

---
source: session-c2Vzc2lvbi0… (persisted, captured through seq 1841) · 12 turns ·
digest ≈5.9K tok · text retained 100% · digest cache hit
```

Failure modes are answers too:

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
| pinned | the first turn's task statement, so the caller always knows what the session was about |
| dropped | whatever still does not fit, oldest first |

Reasoning blocks, bookkeeping events (`step/*`, `job/*`, delivery receipts),
system prompts, tool output bodies, and **host-injected user-role messages**
(`runtime-context`, `skill-catalog`, `time-context`) never enter the digest.
Only a human or a peer agent counts as conversation. Tool results are reduced to
one line, and failures are marked `[error]`.

Measured on the same 69 sessions:

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

Self-consult is refused, so a session cannot recurse into itself.

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
- **Nothing extra is collected.** The plugin has no telemetry, no network calls
  of its own, and writes nothing except the child sessions the host creates.
- **`mode=read` still returns text**, it just does not spend a child turn.
- **Child sessions persist on disk** (the store has no delete API), nested under
  the caller.
- **The offline tooling stays offline**: `dump` reads `$DSH_HOME/sessions` and
  writes JSON; `bench` only reads those dumps.

See [SECURITY.md](SECURITY.md) for reporting a vulnerability.

## Development

```sh
npm test                                        # 30 unit tests, synthetic fixtures
npm run dump -- --out ./session-dumps --limit 50  # read $DSH_HOME/sessions
npm run bench -- ./session-dumps                  # digest cost table
```

Tests use inline synthetic events: no session logs, no fixtures from a real
installation, no network, no running harness. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the layout and the rules a fixture must
follow.

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

## License

MIT — see [LICENSE](LICENSE).
