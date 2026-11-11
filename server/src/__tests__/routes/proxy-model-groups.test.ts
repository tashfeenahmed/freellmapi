import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setUnifyEnabled, setUnifyOverrides } from '../../services/model-groups.js';
import { setRoutingStrategy } from '../../services/router.js';
import { setCompressionConfig } from '../../services/compression/config.js';
import { _clearStoreForTesting } from '../../services/context-handoff.js';
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
  let temporarilyDisabledModels: number[] = [];
  let addedProfileModelIds: number[] = [];
  let addedModels: number[] = [];

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
    setUnifyOverrides({ merges: [], splits: [] });
    setRoutingStrategy('priority');
    addModel('groq', 'tum-groq', 'Test Unify Model', 1);
    addModel('cerebras', 'tum-cerebras', 'Test Unify Model', 2);
    addKey('groq');
    addKey('cerebras');
  });

  afterEach(() => {
    for (const id of addedProfileModelIds) getDb().prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(id);
    addedProfileModelIds = [];
    for (const id of addedModels) {
      getDb().prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
      getDb().prepare('DELETE FROM models WHERE id = ?').run(id);
    }
    addedModels = [];
    for (const id of temporarilyDisabledModels) getDb().prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(id);
    temporarilyDisabledModels = [];
    setCompressionConfig({ mode: 'off' });
    _clearStoreForTesting();
    vi.unstubAllEnvs();
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

  it.each([undefined, 'compression-session-header'])(
    'keeps the sticky group member when compression ages the first user turn (header %s)',
    async (sessionId) => {
      setCompressionConfig({ mode: 'aggressive' });
      const db = getDb();
      const groq = db.prepare("SELECT id FROM models WHERE model_id = 'tum-groq'").get() as { id: number };
      const cerebras = db.prepare("SELECT id FROM models WHERE model_id = 'tum-cerebras'").get() as { id: number };
      const setPriority = (id: number, priority: number) =>
        db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(priority, id);
      const originalFetch = global.fetch;
      const upstreamBodies: any[] = [];
      vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('api.groq.com') || u.includes('api.cerebras.ai')) {
          upstreamBodies.push(JSON.parse(init.body));
          return completion(u.includes('api.groq.com') ? 'tum-groq' : 'tum-cerebras', 'answer');
        }
        return originalFetch(url, init);
      });
      const headers = { ...authHeaders(), ...(sessionId ? { 'x-session-id': sessionId } : {}) };
      const first = `I need help with ${sessionId ?? 'headerless'} session routing.\n${'Extra background about the work. '.repeat(80)}`;
      setPriority(cerebras.id, 1);
      setPriority(groq.id, 2);
      const start = await request(app, 'POST', '/v1/chat/completions', {
        model: 'test-unify-model', messages: [{ role: 'user', content: first }],
      }, headers);
      expect(start.status).toBe(200);
      expect(start.headers.get('x-routed-via')).toContain('cerebras');

      setPriority(groq.id, 1);
      setPriority(cerebras.id, 2);
      const conversation = [{ role: 'user', content: first }];
      for (let i = 0; i < 8; i += 1) {
        conversation.push({ role: 'assistant', content: 'answer' }, { role: 'user', content: 'continue' });
      }
      const next = await request(app, 'POST', '/v1/chat/completions', {
        model: 'test-unify-model', messages: conversation,
      }, headers);
      expect(next.status).toBe(200);
      expect(upstreamBodies.at(-1).messages[0].content).toContain('[compressed older turn]');
      expect(next.headers.get('x-routed-via')).toContain('cerebras');
    },
  );

  it('retains the handoff when compression changes the first user turn and the model switches', async () => {
    vi.stubEnv('FREELLMAPI_CONTEXT_HANDOFF', 'on_model_switch');
    setCompressionConfig({ mode: 'aggressive' });
    const db = getDb();
    const cerebras = db.prepare("SELECT id FROM models WHERE model_id = 'tum-cerebras'").get() as { id: number };
    const groq = db.prepare("SELECT id FROM models WHERE model_id = 'tum-groq'").get() as { id: number };
    temporarilyDisabledModels = (db.prepare('SELECT id FROM models WHERE enabled = 1 AND id NOT IN (?, ?)').all(cerebras.id, groq.id) as { id: number }[]).map(row => row.id);
    db.prepare('UPDATE models SET enabled = 0 WHERE id NOT IN (?, ?)').run(cerebras.id, groq.id);
    addedProfileModelIds = [cerebras.id, groq.id];
    const addToProfiles = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) SELECT id, ?, ?, 1 FROM profiles');
    addToProfiles.run(cerebras.id, 1);
    addToProfiles.run(groq.id, 2);
    db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(-10, cerebras.id);
    db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(-9, groq.id);
    const originalFetch = global.fetch;
    let secondTurn = false;
    let fallbackBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.cerebras.ai')) {
        return secondTurn
          ? new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
          : completion('tum-cerebras', 'answer');
      }
      if (u.includes('api.groq.com')) {
        fallbackBody = JSON.parse(init.body);
        return completion('tum-groq', 'fallback answer');
      }
      return originalFetch(url, init);
    });
    const first = `I need help with a handoff after compression.\n${'Background about the work. '.repeat(80)}`;
    const start = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto', messages: [{ role: 'user', content: first }],
    }, authHeaders());
    expect(start.status).toBe(200);
    expect(start.headers.get('x-routed-via')).toContain('cerebras');

    const conversation = [{ role: 'user', content: first }];
    for (let i = 0; i < 8; i += 1) {
      conversation.push({ role: 'assistant', content: 'answer' }, { role: 'user', content: 'continue' });
    }
    secondTurn = true;
    const next = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto', messages: conversation,
    }, authHeaders());
    expect(next.status).toBe(200);
    expect(next.headers.get('x-routed-via')).toContain('groq');
    expect(fallbackBody.messages.some((message: any) =>
      message.role === 'user' && message.content.startsWith('[compressed older turn]'))).toBe(true);
    expect(fallbackBody.messages.some((message: any) =>
      message.role === 'system' && message.content.startsWith('FreeLLMAPI context handoff:'))).toBe(true);
  });

  it('restores remembered reasoning after compression ages the session opener', async () => {
    setCompressionConfig({ mode: 'aggressive' });
    const model = addModel('opencode', 'compression-reasoning-model', 'Compression Reasoning Model', 1);
    addedModels.push(model);
    addKey('opencode');
    const originalFetch = global.fetch;
    let turn = 0;
    let nextBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      if (String(url).includes('opencode.ai')) {
        turn += 1;
        if (turn === 2) nextBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          id: 'chatcmpl-reasoning', object: 'chat.completion', created: 1, model: 'compression-reasoning-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'answer', ...(turn === 1 ? { reasoning_content: 'remembered trace' } : {}) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, init);
    });
    const first = `I need help preserving a reasoning trace.\n${'Background about the work. '.repeat(80)}`;
    const start = await request(app, 'POST', '/v1/chat/completions', {
      model: 'opencode:compression-reasoning-model', messages: [{ role: 'user', content: first }],
    }, authHeaders());
    expect(start.status).toBe(200);

    const conversation = [{ role: 'user', content: first }];
    for (let i = 0; i < 8; i += 1) {
      conversation.push({ role: 'assistant', content: 'answer' }, { role: 'user', content: 'continue' });
    }
    const next = await request(app, 'POST', '/v1/chat/completions', {
      model: 'opencode:compression-reasoning-model', messages: conversation,
    }, authHeaders());
    expect(next.status).toBe(200);
    expect(nextBody.messages[0].content).toContain('[compressed older turn]');
    expect(nextBody.messages.filter((message: any) => message.role === 'assistant').at(-1).reasoning_content).toBe('remembered trace');
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
