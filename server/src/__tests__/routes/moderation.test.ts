import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { listModerationModels, resolveModel } from '../../services/moderation.js';

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

function insertKey(platform: string): number {
  const { encrypted, iv, authTag } = encrypt('sk-test');
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
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
});
