/**
 * Session-identity and tool-policy helpers for dsh-session-consult.
 *
 * Kept free of DSH imports so the rules are unit testable and the plugin stays
 * loadable from any install location (a host profile may not have the
 * `@deepseek-ai/*` packages resolvable from the plugin's own directory).
 */

/**
 * Tools that must never survive into a consult child: they would let it act on
 * a foreign session's record instead of reading it.
 */
export const MUTATING_TOOLS = Object.freeze([
  'bash',
  'pwsh',
  'shell',
  'terminal',
  'write',
  'edit',
  'apply_patch',
  'present',
  'subagent',
  'subagent_fork',
  'workflow',
  'job_kill',
  'jobs_kill',
  'schedule_create',
  'schedule_edit',
  'schedule_delete',
  'ask_user_question',
  'todo_write',
  'create_goal',
  'update_goal',
  'plugin_manager',
  'consult_session',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'web_fetch',
  'web_search',
]);

/**
 * Unwrap a canonical `@[label](dsh-session:<base64url>)` mention or a bare
 * `dsh-session:<base64url>` URI into the underlying session id. Anything else
 * is returned trimmed and unchanged.
 *
 * @param {string} input raw tool argument
 * @returns {string} session id
 */
export function normalizeSessionId(input) {
  const value = String(input ?? '').trim();
  const linkStart = value.indexOf('](');
  const uri = value.startsWith('@[') && linkStart !== -1 && value.endsWith(')')
    ? value.slice(linkStart + 2, -1)
    : value;
  const scheme = 'dsh-session:';
  if (!uri.startsWith(scheme)) return uri;
  const encoded = uri.slice(scheme.length);
  try {
    return Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return encoded;
  }
}

/**
 * Build the `tools.restrict()` filter for a consult child.
 *
 * An allow-list of read-only tools is preferred: everything else — shells,
 * writers, network, messaging, subagents, even this plugin's own tool —
 * disappears from the child's view. When the profile knows none of the
 * configured read-only names, fall back to denying the mutating set so a
 * custom profile still gets a restricted child.
 *
 * `tools.restrict()` rejects names the profile does not register, so every
 * candidate is filtered through `known()` first.
 *
 * @param {object} options
 * @param {(name: string) => boolean} options.known whether the profile has this tool
 * @param {string[]} [options.readTools] read-only allow-list
 * @param {string[]} [options.denyTools] extra names to deny in the fallback
 * @returns {{allow?: string[], deny?: string[]} | undefined} filter, or
 *   undefined when nothing can be restricted
 */
export function buildToolRestriction({ known, readTools = [], denyTools = [] }) {
  const allow = readTools.filter((name) => known(name));
  if (allow.length > 0) return { allow };

  const deny = [...MUTATING_TOOLS, ...denyTools].filter((name) => known(name));
  return deny.length === 0 ? undefined : { deny };
}
