import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setUnifyEnabled } from '../../services/model-groups.js';
import { setRoutingStrategy } from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(data); } catch { /* SSE / non-JSON */ }
  return { status: res.status, body: json, headers: res.headers };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

// Insert a catalog row + fallback_config entry, returning its model_db_id.
function addModel(platform: string, modelId: string, displayName: string, priority: number): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision)
    VALUES (?, ?, ?, 5, 5, 'Large', 100, NULL, NULL, NULL, '~10M', 131072, 1, 0)
  `).run(platform, modelId, displayName);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  return id;
}

function addKey(platform: string): void {
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(`test-key-${platform}`);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, `${platform}-key`, encrypted, iv, authTag);
}

// A mocked upstream chat completion response (OpenAI-compatible shape).
function completion(model: string, content: string) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// "Test Unify Model" served by both Groq and Cerebras — distinct model_ids that
// normalize to the same group key. (Groq priority 1, so it's tried first under
// the 'priority' strategy, which lets us exercise cross-provider failover.)
describe('Model unification (group the same model across providers)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    // fallback_config FK-references models(id), so clear it before the rows.
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id IN ('tum-groq', 'tum-cerebras'))").run();
    db.prepare("DELETE FROM models WHERE model_id IN ('tum-groq', 'tum-cerebras')").run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    setUnifyEnabled(true);
    setRoutingStrategy('priority');
    addModel('groq', 'tum-groq', 'Test Unify Model', 1);
    addModel('cerebras', 'tum-cerebras', 'Test Unify Model', 2);
    addKey('groq');
    addKey('cerebras');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /v1/models collapses the two providers into one canonical entry', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    const ours = body.data.filter((m: any) => m.name === 'Test Unify Model');
    expect(ours).toHaveLength(1);
    expect(ours[0].id).toBe('test-unify-model');     // canonical slug
    expect(ours[0].owned_by).toBe('freellmapi');
    // The raw per-provider ids are NOT advertised when unify is on.
    expect(body.data.some((m: any) => m.id === 'tum-groq' || m.id === 'tum-cerebras')).toBe(false);
  });

  it('pinning the canonical id fails over across providers (Groq 429 → Cerebras)', async () => {
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'answer from cerebras');
      return orig(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'test-unify-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toContain('cerebras');
    expect(headers.get('x-routed-via')).toContain('cerebras');
  });

  it('a group-pinned non-streaming session sticks to the last successful provider next turn (#341 sticky-key)', async () => {
    const db = getDb();
    const realFetch = global.fetch;
    const sess = { ...authHeaders(), 'x-session-id': 'sticky-test-1' };
    const groqId = db.prepare("SELECT id FROM models WHERE model_id = 'tum-groq'").get() as { id: number };
    const cerebrasId = db.prepare("SELECT id FROM models WHERE model_id = 'tum-cerebras'").get() as { id: number };
    const setPriority = (modelDbId: number, p: number) =>
      db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(p, modelDbId);
    // Both providers stay healthy throughout, so the only thing that can move the
    // route between turns is stickiness — never a cooldown.
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return completion('tum-groq', 'from groq');
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'from cerebras');
      return realFetch(url, init);
    });

    // Turn 1: make Cerebras priority 1 so it wins outright (no failover), recording
    // it as the sticky provider for this pinned-model session.
    setPriority(cerebrasId.id, 1);
    setPriority(groqId.id, 2);
    const turn1 = await request(app, 'POST', '/v1/chat/completions', {
      model: 'test-unify-model', messages: [{ role: 'user', content: 'first' }],
    }, sess);
    expect(turn1.status).toBe(200);
    expect(turn1.headers.get('x-routed-via')).toContain('cerebras');

    // Flip priority so plain routing would now prefer Groq — sticky must override.
    setPriority(groqId.id, 1);
    setPriority(cerebrasId.id, 2);

    // Turn 2: same session, now a multi-turn conversation (getStickyModel only
    // engages once the session has an assistant turn). Pure priority would pick
    // Groq, but the sticky entry from turn 1 keeps it on Cerebras. This passes
    // only when turn 1 wrote the sticky model under the pinned-id key
    // (stickyStrategyKey); the non-streaming bug wrote it under the (undefined)
    // global strategyKey, so this read missed and Groq won.
    const turn2 = await request(app, 'POST', '/v1/chat/completions', {
      model: 'test-unify-model',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'from cerebras' },
        { role: 'user', content: 'second' },
      ],
    }, sess);
    expect(turn2.status).toBe(200);
    expect(turn2.headers.get('x-routed-via')).toContain('cerebras');
  });

  it('an old per-provider model_id still routes and now fails over within the group', async () => {
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return new Response('{}', { status: 429 });
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'answer from cerebras');
      return orig(url, init);
    });

    // Client sends Groq's raw id — it resolves to the whole group.
    const { status, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'tum-groq',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toContain('cerebras');
  });

  it('returns 429 (never a different model) when all of the group\'s providers are down', async () => {
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com') || u.includes('api.cerebras.ai')) {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      }
      return orig(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'test-unify-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(429);
    expect(body.choices).toBeUndefined(); // no answer from any model
  });

  it('with unify OFF, /v1/models lists each provider separately again', async () => {
    setUnifyEnabled(false);
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    const groq = body.data.find((m: any) => m.id === 'tum-groq');
    const cerebras = body.data.find((m: any) => m.id === 'tum-cerebras');
    expect(groq?.owned_by).toBe('groq');
    expect(cerebras?.owned_by).toBe('cerebras');
    expect(body.data.some((m: any) => m.id === 'test-unify-model')).toBe(false);
  });
});
