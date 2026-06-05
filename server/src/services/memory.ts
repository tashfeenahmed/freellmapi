import { getDb, runWithRetry, recordWriteAndMaybeCheckpoint } from '../db/index.js';

export interface Session {
  id: string;
  source: string;
  user_id: string | null;
  model: string | null;
  system_prompt: string | null;
  parent_session_id: string | null;
  title: string | null;
  ended_at: string | null;
  end_reason: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  reasoning: string | null;
  reasoning_content: string | null;
  timestamp: number;
  created_at: string;
}

export interface SearchResult extends Message {
  snippet: string;
  session_source: string;
  session_model: string | null;
  session_title: string | null;
}

export interface SearchOptions {
  limit?: number;
  sourceFilter?: string[];
  excludeSources?: string[];
  roleFilter?: string[];
}

/**
 * Sanitizes queries to prevent FTS5 syntax errors, formatting search terms
 * as safely-escaped phrases combined with AND operators.
 * Matches Hermes' _sanitize_fts5_query() behavior: strips special chars,
 * wraps hyphenated terms in quotes, drops dangling operators.
 */
export function sanitizeFts5Query(query: string): string {
  const words = query.trim().split(/\s+/).map(w => {
    // Strip out double quotes and any non-alphanumeric/dash/underscore chars
    const clean = w.replace(/[^a-zA-Z0-9\-_]/g, '');
    // Ensure the token has at least one alphanumeric character to avoid lone dashes/underscores
    if (!/[a-zA-Z0-9]/.test(clean)) return '';
    return `"${clean}"`;
  }).filter(Boolean);
  return words.join(' AND ');
}

// ─── Session CRUD ────────────────────────────────────────────────

/**
 * Creates a new session with write-contention retry support.
 */
export function createSession(session: Omit<Session, 'title' | 'ended_at' | 'end_reason' | 'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'cost' | 'created_at' | 'updated_at'>): Session {
  const db = getDb();

  return runWithRetry(() => {
    db.prepare(`
      INSERT INTO chat_sessions (id, source, user_id, model, system_prompt, parent_session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.source,
      session.user_id,
      session.model,
      session.system_prompt,
      session.parent_session_id
    );

    recordWriteAndMaybeCheckpoint();

    const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(session.id) as Session;
    return row;
  });
}

/**
 * Retrieves a session by its ID.
 */
export function getSession(id: string): Session | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as Session | undefined;
}

/**
 * Updates a session's token usage and cost metrics.
 */
export function updateSessionUsage(id: string, promptTokens: number, completionTokens: number, cost: number): void {
  const db = getDb();

  runWithRetry(() => {
    db.prepare(`
      UPDATE chat_sessions
      SET prompt_tokens = prompt_tokens + ?,
          completion_tokens = completion_tokens + ?,
          total_tokens = total_tokens + ?,
          cost = cost + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(promptTokens, completionTokens, promptTokens + completionTokens, cost, id);

    recordWriteAndMaybeCheckpoint();
  });
}

// ─── Session Titles (Hermes parity) ──────────────────────────────

/**
 * Sets a unique title on a session. Titles must be unique across non-NULL values.
 */
export function setSessionTitle(id: string, title: string): void {
  const db = getDb();
  runWithRetry(() => {
    db.prepare('UPDATE chat_sessions SET title = ?, updated_at = datetime(\'now\') WHERE id = ?').run(title, id);
    recordWriteAndMaybeCheckpoint();
  });
}

/**
 * Resolves a session by its title (returns the most recent match in lineage).
 */
export function resolveSessionByTitle(title: string): Session | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM chat_sessions WHERE title = ?').get(title) as Session | undefined;
}

/**
 * Auto-generates the next title in a lineage sequence.
 * "Fix Docker Build" → "Fix Docker Build #2" → "Fix Docker Build #3"
 */
export function getNextTitleInLineage(baseTitle: string): string {
  const db = getDb();
  const stripped = baseTitle.replace(/ #\d+$/, '');
  // Escape LIKE wildcards in the base title to prevent false matches
  const escapedStripped = stripped.replace(/[%_]/g, '\\$&');
  const existing = db.prepare(
    "SELECT title FROM chat_sessions WHERE title LIKE ? ESCAPE '\\' AND title IS NOT NULL ORDER BY title DESC"
  ).all(`${escapedStripped}%`) as { title: string }[];

  if (existing.length === 0) return stripped;

  let maxNum = 1;
  for (const row of existing) {
    const match = row.title.match(/ #(\d+)$/);
    if (match) {
      maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
  }
  return `${stripped} #${maxNum + 1}`;
}

// ─── Session Lifecycle (Hermes parity) ───────────────────────────

/**
 * Marks a session as ended with a reason.
 */
export function endSession(id: string, endReason: string): void {
  const db = getDb();
  runWithRetry(() => {
    db.prepare(`
      UPDATE chat_sessions SET ended_at = datetime('now'), end_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(endReason, id);
    recordWriteAndMaybeCheckpoint();
  });
}

/**
 * Reopens a previously ended session.
 */
export function reopenSession(id: string): void {
  const db = getDb();
  runWithRetry(() => {
    db.prepare(`
      UPDATE chat_sessions SET ended_at = NULL, end_reason = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    recordWriteAndMaybeCheckpoint();
  });
}

// ─── Messages ────────────────────────────────────────────────────

/**
 * Appends a new message, triggering automatic FTS5 index syncing.
 */
export function appendMessage(message: Omit<Message, 'timestamp' | 'created_at'>): Message {
  const db = getDb();

  return runWithRetry(() => {
    db.prepare(`
      INSERT INTO messages (id, session_id, role, content, tool_calls, reasoning, reasoning_content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.session_id,
      message.role,
      message.content,
      message.tool_calls,
      message.reasoning,
      message.reasoning_content
    );

    recordWriteAndMaybeCheckpoint();

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id) as Message;
    return row;
  });
}

/**
 * Retrieves all messages in a session ordered by timestamp.
 */
export function getMessages(sessionId: string): Message[] {
  const db = getDb();
  return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as Message[];
}

/**
 * Formats a session's messages as a conversation history for the model.
 */
export function getMessagesAsConversation(sessionId: string): Array<{ role: string; content: string; tool_calls?: any[] }> {
  const messages = getMessages(sessionId);
  return messages.map(m => {
    const formatted: any = {
      role: m.role,
      content: m.content
    };
    if (m.tool_calls) {
      try {
        formatted.tool_calls = JSON.parse(m.tool_calls);
      } catch {}
    }
    return formatted;
  });
}

// ─── FTS5 Search with Snippets + Filters (Hermes parity) ────────

/**
 * Searches messages using SQLite FTS5 full-text search with snippet
 * generation and optional source/role filtering.
 * Matches Hermes' search_messages() API shape.
 */
export function searchMessages(query: string, options: SearchOptions = {}): SearchResult[] {
  const db = getDb();
  const sanitized = sanitizeFts5Query(query);
  if (!sanitized) return [];

  const { limit = 20, sourceFilter, excludeSources, roleFilter } = options;

  const conditions: string[] = ['messages_fts MATCH ?'];
  const params: any[] = [sanitized];

  if (sourceFilter && sourceFilter.length > 0) {
    conditions.push(`s.source IN (${sourceFilter.map(() => '?').join(', ')})`);
    params.push(...sourceFilter);
  }
  if (excludeSources && excludeSources.length > 0) {
    conditions.push(`s.source NOT IN (${excludeSources.map(() => '?').join(', ')})`);
    params.push(...excludeSources);
  }
  if (roleFilter && roleFilter.length > 0) {
    conditions.push(`f.role IN (${roleFilter.map(() => '?').join(', ')})`);
    params.push(...roleFilter);
  }

  params.push(limit);

  // snippet() generates FTS5 highlighted excerpts with >>>match<<< markers
  return db.prepare(`
    SELECT m.*,
           snippet(messages_fts, 3, '>>>', '<<<', '...', 32) AS snippet,
           s.source AS session_source,
           s.model AS session_model,
           s.title AS session_title
    FROM messages_fts f
    JOIN messages m ON m.id = f.message_id
    JOIN chat_sessions s ON s.id = m.session_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY f.rank
    LIMIT ?
  `).all(...params) as SearchResult[];
}

// ─── Session Lineage ─────────────────────────────────────────────

/**
 * Trace ancestors using recursive CTE (Hermes parity).
 * Returns ancestors ordered oldest-first (root → immediate parent).
 */
export function getSessionAncestors(sessionId: string): Session[] {
  const db = getDb();
  // CTE walks parent→grandparent (newest-first), reverse to oldest-first
  const rows = db.prepare(`
    WITH RECURSIVE lineage AS (
      SELECT s.* FROM chat_sessions s
      JOIN chat_sessions child ON child.id = ? AND child.parent_session_id = s.id
      UNION ALL
      SELECT s.* FROM chat_sessions s
      JOIN lineage l ON s.id = l.parent_session_id
    )
    SELECT * FROM lineage
  `).all(sessionId) as Session[];
  return rows.reverse();
}

/**
 * Trace all descendants down the lineage tree using recursive CTE.
 */
export function getSessionDescendants(sessionId: string): Session[] {
  const db = getDb();
  return db.prepare(`
    WITH RECURSIVE descendants AS (
      SELECT * FROM chat_sessions WHERE parent_session_id = ?
      UNION ALL
      SELECT s.* FROM chat_sessions s
      JOIN descendants d ON s.parent_session_id = d.id
    )
    SELECT * FROM descendants
  `).all(sessionId) as Session[];
}

/**
 * Aggregates messages across the entire parent ancestry in correct temporal order.
 */
export function getCompleteLineageConversation(sessionId: string): Array<{ role: string; content: string; tool_calls?: any[] }> {
  const ancestors = getSessionAncestors(sessionId);
  const conversation: Array<{ role: string; content: string; tool_calls?: any[] }> = [];

  // getSessionAncestors already returns oldest-first
  for (const ancestor of ancestors) {
    conversation.push(...getMessagesAsConversation(ancestor.id));
  }

  // Add messages from the current session
  conversation.push(...getMessagesAsConversation(sessionId));

  return conversation;
}

// ─── Session Listing ─────────────────────────────────────────────

/**
 * Lists recent sessions with a preview of the first user message.
 * Matches Hermes' "Recent Sessions with Preview" query.
 */
export function listRecentSessions(limit = 20, sourceFilter?: string): Array<Session & { preview: string }> {
  const db = getDb();
  const conditions = sourceFilter ? 'WHERE s.source = ?' : '';
  const params = sourceFilter ? [sourceFilter, limit] : [limit];

  return db.prepare(`
    SELECT s.*,
           COALESCE(
             (SELECT SUBSTR(m.content, 1, 63) FROM messages m
              WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
              ORDER BY m.timestamp, m.id LIMIT 1),
             ''
           ) AS preview
    FROM chat_sessions s
    ${conditions}
    ORDER BY s.created_at DESC
    LIMIT ?
  `).all(...params) as Array<Session & { preview: string }>;
}

// ─── Export & Cleanup (Hermes parity) ────────────────────────────

/**
 * Prunes ended sessions older than the specified number of days.
 * Only deletes sessions where ended_at IS NOT NULL.
 * Returns the count of deleted sessions.
 */
export function pruneOldSessions(olderThanDays: number, sourceFilter?: string): number {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error(`pruneOldSessions: olderThanDays must be a non-negative finite number, got ${olderThanDays}`);
  }
  const db = getDb();

  return runWithRetry(() => {
    const conditions = [
      'ended_at IS NOT NULL',
      `created_at < datetime('now', '-' || ? || ' days')`
    ];
    const params: any[] = [olderThanDays];

    if (sourceFilter) {
      conditions.push('source = ?');
      params.push(sourceFilter);
    }

    // CASCADE on messages FK handles message cleanup automatically
    const result = db.prepare(`DELETE FROM chat_sessions WHERE ${conditions.join(' AND ')}`).run(...params);
    recordWriteAndMaybeCheckpoint();
    return result.changes;
  });
}

/**
 * Clears all messages from a session but keeps the session record.
 */
export function clearMessages(sessionId: string): void {
  const db = getDb();
  runWithRetry(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    recordWriteAndMaybeCheckpoint();
  });
}

/**
 * Deletes a session and all its messages (via CASCADE).
 */
export function deleteSession(sessionId: string): void {
  const db = getDb();
  runWithRetry(() => {
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
    recordWriteAndMaybeCheckpoint();
  });
}

/**
 * Exports a session with all its messages as a plain object.
 */
export function exportSession(sessionId: string): { session: Session; messages: Message[] } | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  const messages = getMessages(sessionId);
  return { session, messages };
}
