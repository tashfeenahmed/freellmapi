import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setUnifyEnabled, setUnifyOverrides, setProviderPreferences } from '../../services/model-groups.js';
import { setRoutingStrategy } from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
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
    db.prepare('DELETE FROM provider_quota_state').run();
    db.prepare('DELETE FROM provider_quota_observations').run();
    setUnifyEnabled(true);
    setUnifyOverrides({ merges: [], splits: [] });
    setProviderPreferences({ version: 1, groups: {} });
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

  it('pinning "platform:model_id" hard-pins that provider — no cross-provider failover (#580)', async () => {
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'from cerebras');
      return orig(url, init);
    });

    // The fully-qualified id routes to exactly that provider (priority 2 —
    // priority 1 Groq must NOT be used even though it would sort first).
    const pinned = await request(app, 'POST', '/v1/chat/completions', {
      model: 'cerebras:tum-cerebras',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get('x-routed-via')).toContain('cerebras');

    // And when the pinned provider is down, the request FAILS instead of
    // silently serving from a sibling provider.
    const down = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq:tum-groq',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(down.status).toBe(429);
    expect(down.headers.get('x-routed-via') ?? '').not.toContain('cerebras');

    // An unknown platform:model_id keeps the not-found behavior.
    const unknown = await request(app, 'POST', '/v1/chat/completions', {
      model: 'nope:tum-groq',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(unknown.status).toBe(404);
  });

  it('PUT /api/settings/unify splits override un-merges one provider copy (the dashboard opt-out, #580)', async () => {
    const put = await request(app, 'PUT', '/api/settings/unify', {
      overrides: { merges: [], splits: [{ member: 'groq:tum-groq' }] },
    });
    expect(put.status).toBe(200);
    expect(put.body.overrides.splits).toEqual([{ member: 'groq:tum-groq' }]);

    // The split copy is advertised as its own logical model now.
    const { body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    const ours = body.data.filter((m: any) => m.name === 'Test Unify Model');
    expect(ours).toHaveLength(2);

    // Removing the split (the UI's undo) collapses them again.
    const undo = await request(app, 'PUT', '/api/settings/unify', { overrides: { merges: [], splits: [] } });
    expect(undo.status).toBe(200);
    const after = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(after.body.data.filter((m: any) => m.name === 'Test Unify Model')).toHaveLength(1);
  });

  it('persists preferred provider order and uses it without changing the unified model id', async () => {
    const put = await request(app, 'PUT', '/api/settings/unify', {
      providerPreferences: {
        version: 1,
        groups: {
          'test unify model': {
            mode: 'preferred',
            memberOrder: ['cerebras:tum-cerebras', 'groq:tum-groq'],
          },
        },
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.providerPreferences.groups['test unify model'].memberOrder)
      .toEqual(['cerebras:tum-cerebras', 'groq:tum-groq']);

    const orig = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).includes('localhost') || String(url).includes('127.0.0.1')) return orig(url, init);
      if (String(url).includes('api.cerebras.ai')) return completion('tum-cerebras', 'preferred');
      return completion('tum-groq', 'automatic');
    });

    const response = await request(app, 'POST', '/v1/chat/completions', {
      model: 'test-unify-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-routed-via')).toContain('cerebras');
  });

  it('preferred order still fails over when the first provider is unavailable', async () => {
    setProviderPreferences({
      version: 1,
      groups: {
        'test unify model': {
          mode: 'preferred',
          memberOrder: ['cerebras:tum-cerebras', 'groq:tum-groq'],
        },
      },
    });
    getDb().prepare("UPDATE api_keys SET enabled = 0 WHERE platform = 'cerebras'").run();

    const orig = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).includes('localhost') || String(url).includes('127.0.0.1')) return orig(url, init);
      return completion('tum-groq', 'fallback');
    });

    const response = await request(app, 'POST', '/v1/chat/completions', {
      model: 'test-unify-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-routed-via')).toContain('groq');
  });

  it('preferred order skips a provider whose applicable quota pool is known exhausted', async () => {
    setProviderPreferences({
      version: 1,
      groups: {
        'test unify model': {
          mode: 'preferred',
          memberOrder: ['cerebras:tum-cerebras', 'groq:tum-groq'],
        },
      },
    });
    const key = getDb().prepare("SELECT id FROM api_keys WHERE platform = 'cerebras'").get() as { id: number };
    getDb().prepare(`
      INSERT INTO provider_quota_state
        (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, source, confidence)
      VALUES ('cerebras', ?, 'cerebras::shared', 'requests', 30, 0, ?, 'header', 1)
    `).run(key.id, new Date(Date.now() + 60_000).toISOString());

    const upstreams: string[] = [];
    const orig = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      const target = String(url);
      if (target.includes('localhost') || target.includes('127.0.0.1')) return orig(url, init);
      upstreams.push(target);
      return completion('tum-groq', 'quota fallback');
    });

    const response = await request(app, 'POST', '/v1/chat/completions', {
      model: 'test-unify-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-routed-via')).toContain('groq');
    expect(upstreams.some(url => url.includes('api.cerebras.ai'))).toBe(false);
  });

  it('unification is always on: the toggle was removed, so /v1/models stays collapsed even after setUnifyEnabled(false)', async () => {
    // The unify on/off switch was removed from the product; isUnifyEnabled() now
    // always returns true, so writing the old setting has no effect.
    setUnifyEnabled(false);
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    const ours = body.data.filter((m: any) => m.name === 'Test Unify Model');
    expect(ours).toHaveLength(1);
    expect(ours[0].id).toBe('test-unify-model');
    expect(ours[0].owned_by).toBe('freellmapi');
    // The raw per-provider ids are never advertised anymore.
    expect(body.data.some((m: any) => m.id === 'tum-groq' || m.id === 'tum-cerebras')).toBe(false);
  });
});
