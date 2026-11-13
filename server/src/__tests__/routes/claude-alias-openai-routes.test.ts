import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy } from '../../services/router.js';
import { setClaudeModelMap } from '../../services/anthropic-map.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE / non-JSON */ }
  return { status: res.status, body: json, text };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

function activeProfileId(): number | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

function addKey(platform: string): void {
  const secret = encrypt(`${platform}-claude-alias-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'claude-alias', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

// A two-model catalog at fixed priorities: with the 'priority' strategy the
// routed model is fully deterministic, so "which model served" is a clean
// assertion. Unique model ids also make each model its own unify group, so an
// explicit request resolves to exactly one row.
function addModel(modelId: string, priority: number, sizeLabel = 'Small'): number {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools
    )
    VALUES ('groq', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1)
  `).run(modelId, `Alias ${modelId}`, priority, priority, sizeLabel);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  const profileId = activeProfileId();
  if (profileId != null) {
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
      .run(profileId, id, priority);
  }
  return id;
}

function mockUpstream() {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('api.groq.com')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({
          id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'default',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      } as any;
    }
    return origFetch(url, init);
  });
}

function lastServedModel(): string {
  const row = getDb().prepare('SELECT model_id FROM requests ORDER BY id DESC LIMIT 1').get() as { model_id: string } | undefined;
  return row?.model_id ?? '';
}


// GET /v1/models lists claude-opus/sonnet/haiku-4-5 on the OpenAI-shaped
// listing too (#880), so OpenAI-wire clients pick them. These routes used to
// answer 404 model_not_found; they now resolve the listed ids through the same
// Claude family map /v1/messages uses.
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  setRoutingStrategy('priority');
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM models').run();
  addKey('groq');
  addModel('alpha-model', 1, 'Small');
  addModel('beta-model', 2, 'Large');
  mockUpstream();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const surfaces: [string, string, (model: string) => Record<string, unknown>][] = [
  ['chat completions', '/v1/chat/completions', model => ({ model, messages: [{ role: 'user', content: 'hi' }] })],
  ['completions', '/v1/completions', model => ({ model, prompt: 'hi' })],
  ['responses', '/v1/responses', model => ({ model, input: 'hi' })],
];

describe.each(surfaces)('Claude aliases on %s', (_name, path, body) => {
  it('auto-routes an alias mapped to auto (the default)', async () => {
    const res = await request('POST', path, body('claude-sonnet-4-5'), authHeaders());
    expect(res.status).toBe(200);
    expect(lastServedModel()).toBe('alpha-model');
  });

  it('serves the catalog model the family is pinned to', async () => {
    setClaudeModelMap({ sonnet: 'beta-model' });
    const res = await request('POST', path, body('claude-sonnet-4-5'), authHeaders());
    expect(res.status).toBe(200);
    expect(lastServedModel()).toBe('beta-model');
  });

  it('stays inside the tier pool for a tier selector', async () => {
    setClaudeModelMap({ haiku: 'tier:mid' });
    const res = await request('POST', path, body('claude-haiku-4-5'), authHeaders());
    expect(res.status).toBe(200);
    // Priority order would pick alpha-model (Small); tier:mid is Large only.
    expect(lastServedModel()).toBe('beta-model');
  });

  it('lets a real catalog row with the alias id win', async () => {
    addModel('claude-opus-4-5', 3);
    setClaudeModelMap({ opus: 'alpha-model' });
    const res = await request('POST', path, body('claude-opus-4-5'), authHeaders());
    expect(res.status).toBe(200);
    expect(lastServedModel()).toBe('claude-opus-4-5');
  });

  it('still rejects a Claude-looking id that is not listed', async () => {
    const res = await request('POST', path, body('claude-3-opus-20240229'), authHeaders());
    expect([400, 404]).toContain(res.status);
    expect(res.body?.error?.code).toBe('model_not_found');
  });
});
