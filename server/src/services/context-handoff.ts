import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from '../lib/content.js';

export type ContextHandoffMode = 'off' | 'on_model_switch';

type TrimmedMessage = { role: string; content: string };

type SessionContext = {
  lastModelKey?: string;
  recentMessages: TrimmedMessage[];
  updatedAt: number;
};

const MAX_RECENT_MESSAGES = 12;
const MAX_HANDOFF_CHARS = 6000;
const MAX_CONTENT_PER_MSG = 500;
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_STORE_SIZE = 500;

// (MAX_HANDOFF_CHARS chars + ~400 overhead chars) / 4 chars-per-token — conservative upper bound.
// Exported so proxy.ts can pad the routing token estimate to account for the injected message
// before routeRequest() runs its context-window and TPM checks.
export const HANDOFF_MAX_TOKENS = Math.ceil((MAX_HANDOFF_CHARS + 400) / 4);

const store = new Map<string, SessionContext>();

export function getContextHandoffMode(): ContextHandoffMode {
  const raw = process.env.FREELLMAPI_CONTEXT_HANDOFF?.trim().toLowerCase();
  return raw === 'on_model_switch' ? 'on_model_switch' : 'off';
}

// Slice without cutting through a surrogate pair. A bare String.slice can
// leave a lone high surrogate when it lands mid astral-plane char (emoji etc.),
// and some providers 400 on a lone surrogate. Trim that trailing half-char off.
// (Lib-agnostic — String.prototype.toWellFormed needs the es2024 lib target.)
function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastCode = text.charCodeAt(max - 1);
  const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

function trimContent(content: ChatMessage['content']): string {
  const text = contentToString(content);
  return text.length > MAX_CONTENT_PER_MSG ? safeSlice(text, MAX_CONTENT_PER_MSG) + '…' : text;
}

function pruneExpired(): void {
  if (store.size === 0) return;
  const now = Date.now();
  for (const [key, ctx] of store) {
    if (now - ctx.updatedAt > SESSION_TTL_MS) store.delete(key);
  }
}

export function recordIncomingMessages(sessionKey: string, messages: ChatMessage[]): void {
  if (!sessionKey) return;
  pruneExpired();

  const trimmed = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: trimContent(m.content) }))
    .slice(-MAX_RECENT_MESSAGES);

  // Mutate in place to preserve lastModelKey written by recordSuccessfulModel
  // on concurrent/overlapping requests without replacing the whole entry.
  // If the incoming payload has no assistant turns, treat it as a fresh conversation
  // and clear lastModelKey — prevents spurious handoffs when a session ID is reused
  // after the sticky-session (30 min) TTL expires but before the handoff TTL (3 h).
  const hasAssistant = messages.some(m => m.role === 'assistant');
  const existing = store.get(sessionKey);
  if (existing) {
    if (!hasAssistant) existing.lastModelKey = undefined;
    existing.recentMessages = trimmed;
    existing.updatedAt = Date.now();
  } else {
    store.set(sessionKey, { recentMessages: trimmed, updatedAt: Date.now() });
  }

  // Size cap: TTL-prune first; if store is still over the limit, evict the
  // oldest entries by updatedAt. Mirrors the stickySessionMap 500-entry pattern.
  if (store.size > MAX_STORE_SIZE) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (now - v.updatedAt > SESSION_TTL_MS) store.delete(k);
    }
    if (store.size > MAX_STORE_SIZE) {
      const sorted = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [k] of sorted.slice(0, store.size - MAX_STORE_SIZE)) store.delete(k);
    }
  }
}

function buildSummary(messages: TrimmedMessage[]): string {
  const lines = messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  const joined = lines.join('\n');
  return joined.length > MAX_HANDOFF_CHARS
    ? safeSlice(joined, MAX_HANDOFF_CHARS) + '\n…[truncated]'
    : joined;
}

// True when a prior successful model is on record for this session, i.e. the
// next request *could* trigger a handoff. proxy.ts uses this to skip padding
// the routing token estimate on turns where injection is impossible (every
// turn 1, and sessions that never switched), avoiding a needless headroom tax.
export function hasPriorModel(sessionKey: string): boolean {
  if (!sessionKey) return false;
  return !!store.get(sessionKey)?.lastModelKey;
}

export function maybeInjectContextHandoff(params: {
  mode: ContextHandoffMode;
  sessionKey: string;
  messages: ChatMessage[];
  selectedModelKey: string;
}): { messages: ChatMessage[]; injected: boolean; injectedTokens: number } {
  const { mode, sessionKey, messages, selectedModelKey } = params;
  if (mode === 'off' || !sessionKey) return { messages, injected: false, injectedTokens: 0 };

  const ctx = store.get(sessionKey);
  if (!ctx?.lastModelKey || ctx.lastModelKey === selectedModelKey) {
    return { messages, injected: false, injectedTokens: 0 };
  }

  // Skip if a handoff message is already present — handles both plain strings
  // and the array-content format that OpenCode/Continue.dev send.
  const alreadyPresent = messages.some(m => {
    if (m.role !== 'system') return false;
    const text = typeof m.content === 'string' ? m.content : contentToString(m.content);
    return text.startsWith('FreeLLMAPI context handoff:');
  });
  if (alreadyPresent) return { messages, injected: false, injectedTokens: 0 };

  const summary = buildSummary(ctx.recentMessages);
  const handoffContent = [
    'FreeLLMAPI context handoff:',
    `You are taking over an ongoing conversation from another model (${ctx.lastModelKey} → ${selectedModelKey}).`,
    'Continue the user\'s task using the conversation context already provided in this request.',
    'Do not restart the task, re-ask already answered setup questions, or discard prior tool results.',
    'Respect the user\'s latest message as the highest-priority instruction.',
    '',
    'Recent session summary:',
    summary,
  ].join('\n');

  const handoffMsg: ChatMessage = { role: 'system', content: handoffContent };

  // Insert after any leading system messages so provider system-prompt ordering is preserved
  const insertAt = messages.findIndex(m => m.role !== 'system');
  const pos = insertAt === -1 ? messages.length : insertAt;

  return {
    messages: [...messages.slice(0, pos), handoffMsg, ...messages.slice(pos)],
    injected: true,
    injectedTokens: Math.ceil(handoffContent.length / 4),
  };
}

export function recordSuccessfulModel(params: {
  sessionKey: string;
  modelKey: string;
}): void {
  const { sessionKey, modelKey } = params;
  if (!sessionKey) return;
  pruneExpired();
  const ctx = store.get(sessionKey);
  if (ctx) {
    ctx.lastModelKey = modelKey;
    ctx.updatedAt = Date.now();
  } else {
    store.set(sessionKey, { lastModelKey: modelKey, recentMessages: [], updatedAt: Date.now() });
    if (store.size > MAX_STORE_SIZE) {
      const now = Date.now();
      for (const [k, v] of store) {
        if (now - v.updatedAt > SESSION_TTL_MS) store.delete(k);
      }
      if (store.size > MAX_STORE_SIZE) {
        const sorted = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        for (const [k] of sorted.slice(0, store.size - MAX_STORE_SIZE)) store.delete(k);
      }
    }
  }
}

// For tests only
export function _clearStoreForTesting(): void {
  store.clear();
}
