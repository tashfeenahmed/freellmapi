import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
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

describe('Provider error redaction', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_proxy_redaction_test_key',
      label: 'proxy-redaction',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts provider secrets from proxy responses and stored analytics', async () => {
    const origFetch = global.fetch;
    const leakedKey = 'gsk_live_should_not_escape_123456789';
    const leakedUrl = 'https://api.groq.com/openai/v1/chat/completions?api_key=sk-live-query-secret';

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({
            error: {
              message: `Invalid Bearer ${leakedKey} for ${leakedUrl}`,
            },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const completion = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/compound-mini',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(completion.status).toBe(502);
    const responseText = JSON.stringify(completion.body);
    expect(responseText).not.toContain(leakedKey);
    expect(responseText).not.toContain(leakedUrl);
    expect(responseText).toContain('[redacted]');

    const errors = await request(app, 'GET', '/api/analytics/errors?range=24h');
    expect(errors.status).toBe(200);
    const analyticsText = JSON.stringify(errors.body);
    expect(analyticsText).not.toContain(leakedKey);
    expect(analyticsText).not.toContain(leakedUrl);
    expect(analyticsText).toContain('[redacted]');
  });
});
