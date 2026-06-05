import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  createSession,
  getSession,
  appendMessage,
  getMessages,
  getMessagesAsConversation,
  searchMessages,
  getSessionAncestors,
  getSessionDescendants,
  getCompleteLineageConversation,
  updateSessionUsage,
  sanitizeFts5Query,
  setSessionTitle,
  resolveSessionByTitle,
  getNextTitleInLineage,
  endSession,
  reopenSession,
  listRecentSessions,
  pruneOldSessions,
  clearMessages,
  deleteSession,
  exportSession
} from '../../services/memory.js';

describe('Memory Service & Hermes Session Storage', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('should create sessions and retrieve them', () => {
    const session = createSession({
      id: 'session-1',
      source: 'web-client',
      user_id: 'user-123',
      model: 'auto',
      system_prompt: 'You are a helpful assistant.',
      parent_session_id: null
    });

    expect(session.id).toBe('session-1');
    expect(session.source).toBe('web-client');
    expect(session.title).toBeNull();
    expect(session.ended_at).toBeNull();
    expect(session.end_reason).toBeNull();
    expect(session.total_tokens).toBe(0);

    const fetched = getSession('session-1');
    expect(fetched?.id).toBe('session-1');
  });

  it('should update token usage metrics and cost', () => {
    createSession({
      id: 'session-1', source: 'web-client', user_id: 'user-123',
      model: 'auto', system_prompt: 'test', parent_session_id: null
    });

    updateSessionUsage('session-1', 10, 20, 0.05);

    const fetched = getSession('session-1');
    expect(fetched?.prompt_tokens).toBe(10);
    expect(fetched?.completion_tokens).toBe(20);
    expect(fetched?.total_tokens).toBe(30);
    expect(fetched?.cost).toBe(0.05);
  });

  it('should append messages and retrieve conversation history', () => {
    createSession({
      id: 'session-1', source: 'web-client', user_id: 'user-123',
      model: 'auto', system_prompt: 'test', parent_session_id: null
    });

    appendMessage({
      id: 'msg-1', session_id: 'session-1', role: 'user',
      content: 'hello assistant', tool_calls: null, reasoning: null, reasoning_content: null
    });

    appendMessage({
      id: 'msg-2', session_id: 'session-1', role: 'assistant',
      content: 'hello user',
      tool_calls: JSON.stringify([{ id: 'tc1', type: 'function', function: { name: 'test', arguments: '{}' } }]),
      reasoning: 'thinking...', reasoning_content: 'thought processes'
    });

    const messages = getMessages('session-1');
    expect(messages.length).toBe(2);

    const conversation = getMessagesAsConversation('session-1');
    expect(conversation.length).toBe(2);
    expect(conversation[0]).toEqual({ role: 'user', content: 'hello assistant' });
    expect(conversation[1].tool_calls?.[0].id).toBe('tc1');
  });

  it('should execute full-text search with snippets and query sanitization', () => {
    createSession({
      id: 'session-1', source: 'web-client', user_id: 'user-123',
      model: 'auto', system_prompt: 'test', parent_session_id: null
    });

    appendMessage({
      id: 'msg-1', session_id: 'session-1', role: 'user',
      content: 'the quick brown fox jumps over the lazy dog',
      tool_calls: null, reasoning: null, reasoning_content: null
    });

    appendMessage({
      id: 'msg-2', session_id: 'session-1', role: 'assistant',
      content: 'completely unrelated text content here',
      tool_calls: null, reasoning: null, reasoning_content: null
    });

    // Query sanitization
    expect(sanitizeFts5Query('fox jumps')).toBe('"fox" AND "jumps"');
    expect(sanitizeFts5Query('  "weird - syntax* " ')).toBe('"weird" AND "syntax"');

    // Basic search returns snippets
    const results = searchMessages('fox jumps');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('msg-1');
    expect(results[0].snippet).toContain('>>>');
    expect(results[0].snippet).toContain('<<<');
    expect(results[0].session_source).toBe('web-client');

    // Filtered search by role
    const userOnly = searchMessages('fox', { roleFilter: ['user'] });
    expect(userOnly.length).toBe(1);
    const assistantOnly = searchMessages('fox', { roleFilter: ['assistant'] });
    expect(assistantOnly.length).toBe(0);

    // Filtered search by source
    const webOnly = searchMessages('fox', { sourceFilter: ['web-client'] });
    expect(webOnly.length).toBe(1);
    const telegramOnly = searchMessages('fox', { sourceFilter: ['telegram'] });
    expect(telegramOnly.length).toBe(0);

    // Exclude sources
    const excludeWeb = searchMessages('fox', { excludeSources: ['web-client'] });
    expect(excludeWeb.length).toBe(0);
  });

  it('should support session titles with uniqueness and auto-increment', () => {
    createSession({
      id: 'session-1', source: 'cli', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: null
    });

    setSessionTitle('session-1', 'Fix Docker Build');
    const resolved = resolveSessionByTitle('Fix Docker Build');
    expect(resolved?.id).toBe('session-1');

    // Auto-increment title
    const next = getNextTitleInLineage('Fix Docker Build');
    expect(next).toBe('Fix Docker Build #2');

    // Create second session with incremented title
    createSession({
      id: 'session-2', source: 'cli', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: 'session-1'
    });
    setSessionTitle('session-2', 'Fix Docker Build #2');

    const next2 = getNextTitleInLineage('Fix Docker Build');
    expect(next2).toBe('Fix Docker Build #3');
  });

  it('should support session end/reopen lifecycle', () => {
    createSession({
      id: 'session-1', source: 'cli', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: null
    });

    endSession('session-1', 'user_exit');
    let session = getSession('session-1');
    expect(session?.ended_at).toBeTruthy();
    expect(session?.end_reason).toBe('user_exit');

    reopenSession('session-1');
    session = getSession('session-1');
    expect(session?.ended_at).toBeNull();
    expect(session?.end_reason).toBeNull();
  });

  it('should support parent-child session lineages with recursive CTE', () => {
    createSession({
      id: 'grandparent', source: 'web-client', user_id: 'user-1',
      model: 'auto', system_prompt: 'gp', parent_session_id: null
    });
    appendMessage({
      id: 'g-msg', session_id: 'grandparent', role: 'user',
      content: 'grandparent message', tool_calls: null, reasoning: null, reasoning_content: null
    });

    createSession({
      id: 'parent', source: 'web-client', user_id: 'user-1',
      model: 'auto', system_prompt: 'p', parent_session_id: 'grandparent'
    });
    appendMessage({
      id: 'p-msg', session_id: 'parent', role: 'assistant',
      content: 'parent message', tool_calls: null, reasoning: null, reasoning_content: null
    });

    createSession({
      id: 'current', source: 'web-client', user_id: 'user-1',
      model: 'auto', system_prompt: 'c', parent_session_id: 'parent'
    });
    appendMessage({
      id: 'c-msg', session_id: 'current', role: 'user',
      content: 'current message', tool_calls: null, reasoning: null, reasoning_content: null
    });

    // Ancestors
    const ancestors = getSessionAncestors('current');
    expect(ancestors.length).toBe(2);
    const ancestorIds = ancestors.map(a => a.id);
    expect(ancestorIds).toContain('grandparent');
    expect(ancestorIds).toContain('parent');

    // Descendants
    const descendants = getSessionDescendants('grandparent');
    expect(descendants.length).toBe(2);
    const descendantIds = descendants.map(d => d.id);
    expect(descendantIds).toContain('parent');
    expect(descendantIds).toContain('current');

    // Complete lineage conversation
    const fullConv = getCompleteLineageConversation('current');
    expect(fullConv.length).toBe(3);
    expect(fullConv[0]).toEqual({ role: 'user', content: 'grandparent message' });
    expect(fullConv[1]).toEqual({ role: 'assistant', content: 'parent message' });
    expect(fullConv[2]).toEqual({ role: 'user', content: 'current message' });
  });

  it('should list recent sessions with preview', () => {
    createSession({
      id: 's1', source: 'cli', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: null
    });
    appendMessage({
      id: 'm1', session_id: 's1', role: 'user',
      content: 'This is the first user message in session 1',
      tool_calls: null, reasoning: null, reasoning_content: null
    });

    createSession({
      id: 's2', source: 'telegram', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: null
    });

    const all = listRecentSessions();
    expect(all.length).toBe(2);
    // Most recent first
    expect(all[0].preview).toBeDefined();

    // Filter by source
    const cliOnly = listRecentSessions(20, 'cli');
    expect(cliOnly.length).toBe(1);
    expect(cliOnly[0].id).toBe('s1');
    expect(cliOnly[0].preview).toContain('first user message');
  });

  it('should prune old ended sessions', () => {
    const db = getDb();

    // Create a session and backdate it
    createSession({
      id: 'old-session', source: 'cli', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: null
    });
    appendMessage({
      id: 'old-msg', session_id: 'old-session', role: 'user',
      content: 'old content', tool_calls: null, reasoning: null, reasoning_content: null
    });
    endSession('old-session', 'user_exit');

    // Backdate to 100 days ago
    db.prepare("UPDATE chat_sessions SET created_at = datetime('now', '-100 days') WHERE id = 'old-session'").run();

    // Create a recent ended session
    createSession({
      id: 'new-session', source: 'cli', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: null
    });
    endSession('new-session', 'user_exit');

    // Create an active (non-ended) old session
    createSession({
      id: 'active-session', source: 'cli', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: null
    });
    db.prepare("UPDATE chat_sessions SET created_at = datetime('now', '-100 days') WHERE id = 'active-session'").run();

    // Prune sessions older than 90 days
    const pruned = pruneOldSessions(90);
    expect(pruned).toBe(1); // Only old-session (ended + old)

    // Verify old-session is gone, new-session and active-session remain
    expect(getSession('old-session')).toBeUndefined();
    expect(getSession('new-session')).toBeDefined();
    expect(getSession('active-session')).toBeDefined();

    // Messages should be cascade-deleted
    expect(getMessages('old-session').length).toBe(0);
  });

  it('should clear messages and delete sessions', () => {
    createSession({
      id: 'session-1', source: 'cli', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: null
    });
    appendMessage({
      id: 'msg-1', session_id: 'session-1', role: 'user',
      content: 'test', tool_calls: null, reasoning: null, reasoning_content: null
    });

    // Clear messages but keep session
    clearMessages('session-1');
    expect(getSession('session-1')).toBeDefined();
    expect(getMessages('session-1').length).toBe(0);

    // Delete session entirely
    appendMessage({
      id: 'msg-2', session_id: 'session-1', role: 'user',
      content: 'test2', tool_calls: null, reasoning: null, reasoning_content: null
    });
    deleteSession('session-1');
    expect(getSession('session-1')).toBeUndefined();
  });

  it('should export a session with all messages', () => {
    createSession({
      id: 'session-1', source: 'cli', user_id: null,
      model: 'auto', system_prompt: null, parent_session_id: null
    });
    appendMessage({
      id: 'msg-1', session_id: 'session-1', role: 'user',
      content: 'exported content', tool_calls: null, reasoning: null, reasoning_content: null
    });

    const exported = exportSession('session-1');
    expect(exported).toBeDefined();
    expect(exported?.session.id).toBe('session-1');
    expect(exported?.messages.length).toBe(1);
    expect(exported?.messages[0].content).toBe('exported content');

    // Non-existent session
    expect(exportSession('nope')).toBeUndefined();
  });
});
