/**
 * Session reading helpers for dsh-session-consult.
 *
 * The consulted session is only ever read: a live session is read from memory,
 * a cold or cross-process one through the persistence service's read handle.
 * Nothing here writes, steers, locks, or resumes the target session.
 */

/**
 * @typedef {object} SessionRead
 * @property {Array<object>} events contiguous events (the header is not included
 *   by the persistence read handle)
 * @property {object} header stored session header
 * @property {'live' | 'persisted'} source where the events came from
 */

/**
 * Read a session's events, preferring the live in-memory session when this
 * process hosts it.
 *
 * @param {object} services
 * @param {object} services.sessions the `sessions` service, if mounted
 * @param {object} services.persistence the `sessionPersistence` service
 * @param {string} sessionId target session id
 * @returns {Promise<SessionRead>}
 */
export async function readSession({ sessions, persistence }, sessionId) {
  const live = sessions?.get?.(sessionId);
  if (live !== undefined && typeof live.snapshotEvents === 'function') {
    return {
      events: live.snapshotEvents(),
      header: live.header ?? live.session?.header ?? {},
      source: 'live',
    };
  }

  if (persistence === undefined) {
    throw new Error('consult: no session persistence service is mounted');
  }

  let handle;
  try {
    handle = await persistence.open(sessionId, 'read');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`consult: cannot read session "${sessionId}": ${reason}`);
  }

  try {
    const { events } = await handle.read();
    return { events, header: handle.header ?? {}, source: 'persisted' };
  } finally {
    try {
      await handle.close?.();
    } catch {
      /* a read handle that fails to close must not mask the read */
    }
  }
}

/**
 * The final assistant text appended after `fromSeq`.
 *
 * @param {object} session session exposing `snapshotEvents()`
 * @param {number} fromSeq first sequence number to consider
 * @returns {string}
 */
export function finalAnswer(session, fromSeq) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  const parts = [];
  for (const event of events) {
    if ((event.seq ?? 0) < fromSeq || event.type !== 'assistant/message') continue;
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * The first error reported by a turn that ended at or after `fromSeq`.
 *
 * @param {object} session session exposing `snapshotEvents()`
 * @param {number} fromSeq first sequence number to consider
 * @returns {{message: string, code?: string} | undefined}
 */
export function turnFailure(session, fromSeq) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  for (const event of events) {
    if ((event.seq ?? 0) < fromSeq || event.type !== 'turn/end') continue;
    const reason = event.data?.reason;
    if (reason?.kind === 'error') {
      const error = reason.error ?? {};
      return { message: String(error.message ?? 'unknown error'), ...(error.code ? { code: error.code } : {}) };
    }
    if (reason?.kind === 'aborted') return { message: 'the consult turn was aborted' };
  }
  return undefined;
}

/**
 * Race a promise against a deadline, aborting the work on timeout.
 *
 * @template T
 * @param {Promise<T>} promise work to bound
 * @param {number} timeoutMs deadline in milliseconds
 * @param {() => void} [onTimeout] called once when the deadline fires
 * @returns {Promise<T>}
 */
export async function withDeadline(promise, timeoutMs, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* an abort that throws must not replace the timeout error */
      }
      reject(new Error(`consult: the consult agent did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
