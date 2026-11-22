# Changelog

## 0.1.0

First public release — published to npm as `dsh-session-consult@0.1.0`.

- `consult_session` tool with `read` and `ask` modes.
- Bounded digest: keeps every human/assistant text block, drops reasoning,
  bookkeeping and most tool output; newest-first allocation with the task
  statement pinned.
- Read-only child agent: an allow-list of read-only tools replaces the caller's
  tool set.
- Digest cache keyed by `(session, captured seq, budget)` and one reused child
  per `(caller, target)`.
- Provenance on every result: source, capture point, size, retention, drops.
- Target discovery: `session` accepts a title fragment through the same
  candidate service the `@` menu uses, and `mode=list` reports what can be
  consulted. Ambiguity is refused with the candidate list, never guessed.
- Live-session awareness: in-flight turns are labelled, not silently reported
  as complete; injected boilerplate (`runtime-context`, `skill-catalog`,
  `time-context`) is excluded, and a text-only tier keeps the conversation when
  a tool trail does not fit.
- Failure surfacing: child errors, aborts and timeouts are reported instead of
  returning an empty answer.
- Offline tooling: `scripts/dump-sessions.mjs` and `src/bench.mjs` to measure
  digest cost on a local session store.
- 30 unit tests; synthetic fixtures only, no absolute paths.
