/** Raw-mention support: `@[label](dsh-session:…)` resolves like the bare id. */
import { normalizeSessionId } from './policy.mjs';

/**
 * Target-session discovery for dsh-session-consult.
 *
 * A caller rarely knows a session id. The canonical `@` mention carries one, but
 * a plain title fragment ("the billing refactor one") should also work, so the
 * plugin resolves through the same candidate service the composer uses and
 * reports ambiguity instead of guessing.
 */

/** A value that already names a session, rather than a title fragment. */
export function looksLikeSessionId(value) {
  const text = String(value ?? '').trim();
  if (/^session-[0-9A-Za-z-]{8,}$/.test(text)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}

/**
 * List sessions matching `query`, excluding the calling session.
 *
 * Uses the host's session-reference resolver when it is mounted (titles, cwd
 * affinity, recency) and falls back to the query service, which yields ids only.
 *
 * @param {object} services
 * @param {object} [services.resolver] the `sessionReferenceResolver` service
 * @param {object} [services.sessionQuery] the `sessionQuery` service
 * @param {object} [services.agent] calling agent (excluded from results)
 * @param {string} query case-insensitive id/cwd/title fragment
 * @param {number} limit maximum candidates
 * @returns {Promise<Array<{id: string, title: string, cwd?: string, createdAt?: number}>>}
 */
export async function discoverSessions({ resolver, sessionQuery, agent }, query = '', limit = 10) {
  if (typeof resolver?.listCandidates === 'function') {
    const candidates = await resolver.listCandidates(agent, query, limit);
    return candidates.map((candidate) => ({
      id: candidate.sessionId,
      title: candidate.displayTitle ?? candidate.label ?? '',
      ...(candidate.cwd === undefined ? {} : { cwd: candidate.cwd }),
      ...(candidate.createdAt === undefined ? {} : { createdAt: candidate.createdAt }),
    }));
  }

  const records = (await sessionQuery?.listSessions?.()) ?? [];
  const needle = query.toLocaleLowerCase();
  return records
    .filter((record) => record?.header?.id !== undefined && record.header.id !== agent?.id)
    .filter((record) => {
      if (needle === '') return true;
      const id = String(record.header.id).toLocaleLowerCase();
      const cwd = String(record.header.cwd ?? '').toLocaleLowerCase();
      return id.includes(needle) || cwd.includes(needle);
    })
    .slice(0, limit)
    .map((record) => ({
      id: record.header.id,
      title: '',
      ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
      ...(record.header.createdAt === undefined ? {} : { createdAt: record.header.createdAt }),
    }));
}

/** Render candidates for an error or a `list` result. */
export function formatCandidates(candidates, { now = Date.now(), limit = 8 } = {}) {
  if (candidates.length === 0) return '  (none)';
  return candidates
    .slice(0, limit)
    .map((candidate) => {
      const title = candidate.title.trim() === '' ? '(untitled)' : candidate.title.trim();
      const age = candidate.createdAt === undefined ? '' : ` · ${relativeAge(now - candidate.createdAt)}`;
      return `  - ${title} · ${candidate.id}${age}`;
    })
    .join('\n');
}

/** Coarse age label for candidate listings. */
export function relativeAge(milliseconds) {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Resolve a tool argument to a session id.
 *
 * Exact identifiers pass through. Anything else is treated as a title/id
 * fragment: one match wins, several matches raise an actionable error listing
 * them, none lists what is available.
 *
 * @param {object} services same shape as {@link discoverSessions}
 * @param {string} raw tool argument
 * @returns {Promise<string>} session id
 */
export async function resolveSessionId(services, raw) {
  const value = normalizeSessionId(raw).trim();
  if (value === '') throw new Error('consult: a target session id or title is required');
  if (looksLikeSessionId(value)) return value;

  const matches = await discoverSessions(services, value, 10);
  if (matches.length === 1) return matches[0].id;

  if (matches.length > 1) {
    const exact = matches.filter((match) => match.id.toLocaleLowerCase() === value.toLocaleLowerCase());
    if (exact.length === 1) return exact[0].id;
    throw new Error(
      `consult: "${value}" matches ${matches.length} sessions — retry with a more specific title or an id:\n${formatCandidates(matches)}`,
    );
  }

  const available = await discoverSessions(services, '', 8);
  throw new Error(`consult: no session matches "${value}". Available sessions:\n${formatCandidates(available)}`);
}
