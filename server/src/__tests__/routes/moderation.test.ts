import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { listModerationModels, resolveModel } from '../../services/moderation.js';
import { clearLastHealthyStampState } from '../../services/health.js';

// POST /v1/moderations (#…): OpenAI-compatible content-moderation shim that
// routes to the first enabled OpenAI/OpenRouter/NVIDIA key and fails over
// across platforms. Covers the model-resolution rules, the failover chain,
// and the route's auth/validation envelope — without hitting any provider.

let app: Express;

async function postModeration(body: unknown, token?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/moderations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json as any };
}

function insertKey(platform: string, modelScopeJson?: string): number {
  const { encrypted, iv, authTag } = encrypt('sk-test');
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1, ?)
  `).run(platform, encrypted, iv, authTag, modelScopeJson ?? null);
  return Number(result.lastInsertRowid);
}

/** Mock provider moderation calls for one or more platforms in one spy.
 *  Failover walks several platforms, so a single mock must answer all of
 *  them (each mockModeration() call would otherwise replace the previous spy). */
function mockModeration(
  handlers: Array<{ platform: string; response: Record<string, unknown>; status?: number }>,
) {
  const urlPatterns: Record<string, string> = {
    openai: 'https://api.openai.com/v1/moderations',
    openrouter: 'https://openrouter.ai/api/v1/moderations',
    nvidia: 'https://integrate.api.nvidia.com/v1/moderations',
  };
  const origFetch = global.fetch;
  const calls: string[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    // Test-harness requests to the ephemeral app server must pass through.
    if (urlStr.startsWith('http://127.0.0.1')) return origFetch(url, init);
    const handler = handlers.find(h => urlStr === urlPatterns[h.platform]);
    if (handler) {
      calls.push(handler.platform);
      return new Response(JSON.stringify({ id: 'modr-test', model: 'omni-moderation-latest', ...handler.response }), {
        status: handler.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected URL in moderation test: ${urlStr}`);
  });
  return calls;
}

function restoreFetch() {
  vi.restoreAllMocks();
}

describe('moderation service — model resolution', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(restoreFetch);

  it('lists one entry per enabled platform, first key per platform', () => {
    insertKey('openai');
    insertKey('openai'); // second openai key must be ignored
    insertKey('nvidia');
    const models = listModerationModels();
    expect(models.map(m => m.platform)).toEqual(['openai', 'nvidia']);
    const openai = models.find(m => m.platform === 'openai')!;
    expect(openai.modelId).toBe('omni-moderation-latest');
    expect(openai.baseUrl).toBe('https://api.openai.com');
  });

  it('ignores disabled or unhealthy keys', () => {
    const { encrypted, iv, authTag } = encrypt('sk-test');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openai', 'off', ?, ?, ?, 'healthy', 0)
    `).run(encrypted, iv, authTag);
    expect(listModerationModels()).toHaveLength(0);
  });

  it('skips a key scoped to another model and takes the next key on the platform (#657)', () => {
    // First key is a relay chat-scope key — moderation must NOT pick it.
    insertKey('openai', '["gpt-4o-mini"]');
    const unscoped = insertKey('openai');
    const models = listModerationModels();
    expect(models.map(m => m.platform)).toEqual(['openai']);
    expect(models[0].keyId).toBe(unscoped);
  });

  it('lists no platform when its only key is scoped out', () => {
    insertKey('openai', '["gpt-4o-mini"]');
    expect(listModerationModels()).toHaveLength(0);
  });

  it('a key scoped exactly to the moderation model serves it', () => {
    const scoped = insertKey('openai', '["omni-moderation-latest"]');
    const models = listModerationModels();
    expect(models.map(m => m.platform)).toEqual(['openai']);
    expect(models[0].keyId).toBe(scoped);
  });

  it('resolveModel maps OpenAI legacy names and unknown models to the default', () => {
    insertKey('openai');
    insertKey('nvidia');
    expect(resolveModel(undefined)).toBe('omni-moderation-latest');
    expect(resolveModel('text-moderation-latest')).toBe('omni-moderation-latest');
    expect(resolveModel('text-moderation-stable')).toBe('omni-moderation-latest');
    // An unknown requested model falls back to the first available default.
    expect(resolveModel('nonsense-model')).toBe('omni-moderation-latest');
  });
});

describe('POST /v1/moderations route', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(restoreFetch);

  it('rejects a request without a valid key', async () => {
    const { status } = await postModeration({ input: 'kill all humans' });
    expect(status).toBe(401);
  });

  it('validates the body shape', async () => {
    const key = getUnifiedApiKey();
    const missing = await postModeration({}, key);
    expect(missing.status).toBe(400);
    const empty = await postModeration({ input: [] }, key);
    expect(empty.status).toBe(400);
  });

  it('proxies to the first enabled platform and returns OpenAI-shaped results', async () => {
    insertKey('openai');
    const calls = mockModeration([
      {
        platform: 'openai',
        response: {
          results: [{ flagged: false, categories: { violence: false }, category_scores: { violence: 0.01 } }],
        },
      },
    ]);
    const { status, body } = await postModeration(
      { input: 'a perfectly fine sentence' },
      getUnifiedApiKey(),
    );
    expect(status).toBe(200);
    expect(calls).toEqual(['openai']);
    expect(body._provider).toBe('openai');
    expect(body.model).toBe('omni-moderation-latest');
    expect(body.results).toHaveLength(1);
    expect(body.results[0].flagged).toBe(false);
  });

  it('fails over to the next platform when the first errors', async () => {
    // openai and openrouter share the default 'omni-moderation-latest'
    // model, so the chain walks openai → openrouter.
    insertKey('openai');
    insertKey('openrouter');
    const calls = mockModeration([
      { platform: 'openai', response: {}, status: 500 },
      { platform: 'openrouter', response: { results: [{ flagged: true }] }, status: 200 },
    ]);
    const { status, body } = await postModeration(
      { input: 'flagged content' },
      getUnifiedApiKey(),
    );
    expect(status).toBe(200);
    expect(body._provider).toBe('openrouter');
    expect(calls).toEqual(['openai', 'openrouter']);
  });

  it('returns 503 when no moderation provider has an enabled key', async () => {
    const { status, body } = await postModeration({ input: 'x' }, getUnifiedApiKey());
    expect(status).toBe(503);
    expect(body.error.message).toContain('No moderation providers available');
  });

  it('a served moderation marks the key as working (#1493)', async () => {
    clearLastHealthyStampState();
    const key = insertKey('openai');
    getDb().prepare("UPDATE api_keys SET status = 'unknown' WHERE id = ?").run(key);
    mockModeration([{ platform: 'openai', response: { results: [{ flagged: false }] } }]);
    const { status } = await postModeration({ input: 'fine' }, getUnifiedApiKey());
    expect(status).toBe(200);
    expect(getDb().prepare('SELECT status, last_healthy_at FROM api_keys WHERE id = ?').get(key))
      .toMatchObject({ status: 'healthy', last_healthy_at: expect.any(String) });
  });

  it('a key at its monthly cap is not used for moderation; the reply is 429 with Retry-After (#1158)', async () => {
    const key = insertKey('openai');
    getDb().prepare('UPDATE api_keys SET monthly_request_cap = 1 WHERE id = ?').run(key);
    const month = new Date().toISOString().slice(0, 7);
    getDb().prepare(
      'INSERT INTO key_monthly_usage (key_id, month, requests, tokens) VALUES (?, ?, 1, 0)',
    ).run(key, month);
    const calls = mockModeration([{ platform: 'openai', response: { results: [{ flagged: false }] } }]);
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/moderations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` },
      body: JSON.stringify({ input: 'x' }),
    });
    server.close();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { type: 'rate_limit_error' } });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // The capped key must never be called.
    expect(calls).toEqual([]);
  });
});
