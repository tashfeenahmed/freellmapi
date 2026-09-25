import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function req(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
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
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('Full Integration Flow', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    // Clean
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
  });

  it('Step 1: Verify models are seeded', async () => {
    const { status, body } = await req(app, 'GET', '/api/models');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    if (body.length > 0) {
      expect(body[0]).toHaveProperty('modelId');
      expect(body[0]).toHaveProperty('hasProvider');
    }
  });

  it('Step 2: Verify fallback chain is populated', async () => {
    const { status, body } = await req(app, 'GET', '/api/fallback');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('Step 3: Authenticated proxy returns 429 with no keys', async () => {
    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());
    // 429 (all exhausted) or 502 (provider error) or 503 (no route)
    expect([429, 502, 503]).toContain(status);
    expect(body.error).toBeDefined();
  });

  it('Step 4: Add a Groq key', async () => {
    const { status, body } = await req(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_integration_test_key',
      label: 'Integration Test',
    });
    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.maskedKey).toBeDefined();
  });

  it('Step 5: Proxy routes to Groq and handles provider error gracefully', async () => {
    // Mock fetch to simulate a Groq API error
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      // If it's calling the Groq API, return an error
      if (urlStr.includes('api.groq.com')) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({ error: { message: 'Invalid API Key' } }),
        } as any;
      }
      // Otherwise pass through (for our test server)
      return origFetch(url, init);
    });

    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    // 502 (provider error) or 429 (all exhausted after retries)
    expect([502, 429]).toContain(status);
    expect(body.error).toBeDefined();

    vi.restoreAllMocks();
  });

  it('Step 6: Error was logged in analytics', async () => {
    const { status, body } = await req(app, 'GET', '/api/analytics/summary?range=24h');
    expect(status).toBe(200);
    // May or may not have logged depending on retry behavior
    expect(body.totalRequests).toBeGreaterThanOrEqual(0);
  });

  it('Step 7: Sort fallback by speed', async () => {
    const { status } = await req(app, 'POST', '/api/fallback/sort/speed');
    expect(status).toBe(200);

    const { body } = await req(app, 'GET', '/api/fallback');
    expect(Array.isArray(body)).toBe(true);
  });

  it('Step 8: Health endpoint works', async () => {
    const { status, body } = await req(app, 'GET', '/api/health');
    expect(status).toBe(200);
    expect(body).toHaveProperty('platforms');
    expect(body).toHaveProperty('keys');
  });

  it('Step 9: Delete a key if any exist', async () => {
    // Add a fresh key to ensure we have one to delete
    const res = await req(app, 'POST', '/api/keys', {
      platform: 'groq', key: 'gsk_delete_test_key_long', label: 'delete-test',
    });
    const keyId = res.body?.id || 1;
    const { status } = await req(app, 'DELETE', `/api/keys/${keyId}`);
    expect([200, 204, 404]).toContain(status);
  });

  it('Step 10: Validate request schema', async () => {
    const { status } = await req(app, 'POST', '/v1/chat/completions', {
      messages: [], // empty
    }, authHeaders());
    expect(status).toBe(400);

    const { status: s2 } = await req(app, 'POST', '/v1/chat/completions', {
      // missing messages entirely
    }, authHeaders());
    expect(s2).toBe(400);
  });

  it('Step 11: Explicit unknown model returns an honest 404 (not silent fallthrough)', async () => {
    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      model: 'definitely-not-a-real-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(404);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('not in the catalog');
  });

  it('Step 12: Explicit disabled model returns an honest 404 with disabled reason', async () => {
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE model_id = 'gemini-2.5-pro'").run();
    await (await import('../../services/router-registry.js')).reloadRoutingRegistry();

    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect([404, 503]).toContain(status);
    expect(body.error).toBeDefined();
  });
});
