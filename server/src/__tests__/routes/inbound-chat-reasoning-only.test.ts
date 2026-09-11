import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy } from '../../services/router.js';

// #1184: on the Ollama/Gemini surfaces (shared runInboundChat), a
// reasoning-only completion — a thinking trace with no text and no tool
// calls — must fail over exactly like a fully empty completion.
//
// The fix is only reachable on providers that keep reasoning_content
// separate from content. OpenAI-compat providers (groq, cerebras, etc.)
// normalizeChoices folds reasoning_content into content before it reaches
// the route layer (intentional Z.ai / Ollama Cloud compatibility), so a
// reasoning-only response arrives as content=thought there — that path is
// handled elsewhere. Google's Gemini provider synthesizes reasoning_content
// from thought parts while leaving content empty, which IS the reachable
// path for this fix.

// ── Gemini response shapes ──────────────────────────────────────────────────
function geminiResponse(parts: Array<{ text: string; thought?: boolean }>, finishReason = 'STOP') {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
  };
}

const REASONING_ONLY = geminiResponse([{ text: 'thinking... a long trace with no visible answer', thought: true }]);
const REASONING_PLUS_TEXT = geminiResponse([
  { text: 'thinking first', thought: true },
  { text: 'the answer' },
]);
const GOOD = geminiResponse([{ text: 'a real answer' }]);

function geminiJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Reasoning-only failover on the shared inbound surface (#1184)', () => {
  let app: Express;
  const routedModels: string[] = [];

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    setRoutingStrategy('priority');
    setSetting('ollama_emulation', 'open-loopback');
    const { encrypted, iv, authTag } = encrypt('AIza_test_google_key_for_reasoning_only');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('google', 'reasoning-only-test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    routedModels.length = 0;
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  afterEach(() => vi.restoreAllMocks());

  // POST /api/chat (Ollama surface, non-stream) against a single google key.
  // The fetch mock intercepts Google's Gemini API and records which model was
  // routed so we can verify failover hops.
  async function postChat(body: Record<string, unknown>, respond: (callIndex: number) => unknown) {
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('generativelanguage.googleapis.com')) {
        const match = String(url).match(/models\/([^:]+):generateContent/);
        routedModels.push(match?.[1] ?? 'unknown');
        return geminiJson(respond(routedModels.length));
      }
      return originalFetch(url, init);
    });
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    server.close();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error frame */ }
    return { status: response.status, body: json, text };
  }

  it('fails over a reasoning-only completion to the next model (non-stream)', async () => {
    const { status, body } = await postChat(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
      callIndex => (callIndex === 1 ? REASONING_ONLY : GOOD),
    );

    expect(status).toBe(200);
    expect(body.message.content).toBe('a real answer');
    // The reasoning trace of the failed hop must not leak into the answer.
    expect(body.message.thinking).toBeUndefined();
    expect(routedModels).toHaveLength(2);
    expect(routedModels[0]).not.toBe(routedModels[1]);

    const rows = getDb()
      .prepare('SELECT status, error FROM requests ORDER BY id')
      .all() as Array<{ status: string; error: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('error');
    expect(rows[0].error).toContain('empty completion');
    expect(rows[1].status).toBe('success');
  });

  it('delivers a reasoning + text completion in one hop (no false failover)', async () => {
    const { status, body } = await postChat(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
      () => REASONING_PLUS_TEXT,
    );

    expect(status).toBe(200);
    expect(body.message.content).toBe('the answer');
    expect(body.message.thinking).toBe('thinking first');
    expect(routedModels).toHaveLength(1);

    const rows = getDb()
      .prepare('SELECT status FROM requests')
      .all() as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
  });

  it('renders exhaustion, never the trace, when every candidate is reasoning-only', async () => {
    const { status, body, text } = await postChat(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
      () => REASONING_ONLY,
    );

    // The client gets an error, not a 200 carrying only a thinking trace.
    expect(status).toBeGreaterThanOrEqual(500);
    expect(body?.error).toBeTruthy();
    expect(text).not.toContain('a long trace with no visible answer');

    const successes = getDb()
      .prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'success'")
      .get() as { n: number };
    expect(successes.n).toBe(0);
  });
});
