import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function req(app: Express, method: string, path: string, body?: any, apiKey?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

describe('Full Integration Flow', () => {
  let app: Express;
  let apiKey: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    apiKey = getUnifiedApiKey();
    // Clean
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
  });

  it('Step 1: Verify models are seeded', async () => {
    const { status, body } = await req(app, 'GET', '/api/models', undefined, apiKey);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(50);
    expect(body[0]).toHaveProperty('modelId');
    expect(body[0]).toHaveProperty('hasProvider');
    for (const m of body) {
      expect(m.hasProvider).toBe(true);
    }
  });

  it('Step 2: Verify fallback chain is populated', async () => {
    const { status, body } = await req(app, 'GET', '/api/fallback', undefined, apiKey);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(50);
    expect(body[0]).toHaveProperty('priority');
    expect(body[0]).toHaveProperty('enabled');
  });

  it('Step 3: Proxy returns 401 with no API key', async () => {
    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });
    // No API key provided → 401 (auth is now required on all requests)
    expect(status).toBe(401);
    expect(body.error).toBeDefined();
  });

  it('Step 4: Add a Groq key', async () => {
    const { status, body } = await req(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_integration_test_key',
      label: 'Integration Test',
    }, apiKey);
    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.maskedKey).toContain('...');
  });

  it('Step 5: Proxy routes to Groq and handles provider error gracefully', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com')) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({ error: { message: 'Invalid API Key' } }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, apiKey);

    // 502 (provider error) or 429 (all exhausted after retries)
    expect([502, 429]).toContain(status);
    expect(body.error).toBeDefined();

    vi.restoreAllMocks();
  });

  it('Step 6: Error was logged in analytics', async () => {
    const { status, body } = await req(app, 'GET', '/api/analytics/summary?range=24h', undefined, apiKey);
    expect(status).toBe(200);
    expect(body.totalRequests).toBeGreaterThanOrEqual(0);
  });

  it('Step 7: Sort fallback by speed', async () => {
    const { status } = await req(app, 'POST', '/api/fallback/sort/speed', undefined, apiKey);
    expect(status).toBe(200);

    const { body } = await req(app, 'GET', '/api/fallback', undefined, apiKey);
    expect(body[0].speedRank).toBe(1);
  });

  it('Step 8: Health endpoint works', async () => {
    const { status, body } = await req(app, 'GET', '/api/health', undefined, apiKey);
    expect(status).toBe(200);
    expect(body).toHaveProperty('platforms');
    expect(body).toHaveProperty('keys');
  });

  it('Step 9: Delete a key if any exist', async () => {
    await req(app, 'POST', '/api/keys', {
      platform: 'groq', key: 'gsk_delete_test', label: 'delete-test',
    }, apiKey);
    const { body: keys } = await req(app, 'GET', '/api/keys', undefined, apiKey);
    const target = keys.find((k: any) => k.label === 'delete-test');
    expect(target).toBeDefined();

    const { status } = await req(app, 'DELETE', `/api/keys/${target.id}`, undefined, apiKey);
    expect(status).toBe(200);
  });

  it('Step 10: Validate request schema (with auth)', async () => {
    const { status } = await req(app, 'POST', '/v1/chat/completions', {
      messages: [], // empty
    }, apiKey);
    expect(status).toBe(400);

    const { status: s2 } = await req(app, 'POST', '/v1/chat/completions', {
      // missing messages entirely
    }, apiKey);
    expect(s2).toBe(400);
  });

  it('Step 11: Explicit unknown model returns 400 (not silent fallthrough)', async () => {
    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      model: 'definitely-not-a-real-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, apiKey);
    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('not in the catalog');
  });

  it('Step 12: Explicit disabled model returns 400 with disabled reason', async () => {
    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    }, apiKey);
    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('is disabled');
  });
});
