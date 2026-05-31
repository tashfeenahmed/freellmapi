import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

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

describe('Proxy authentication and CORS', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('requires the unified API key for loopback chat completions', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  // #103: Claude Code via CC Switch (and other Anthropic-format clients) send
  // the key in the `x-api-key` header, not as an Authorization bearer token.
  it('rejects a wrong key supplied via the x-api-key header', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, { 'x-api-key': 'freellmapi-wrong-key' });

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('accepts the unified key supplied via the x-api-key header', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, { 'x-api-key': getUnifiedApiKey() });

    // Auth passes — it gets past the 401 gate. (Routing then fails because no
    // provider keys are configured in this test DB, which is fine: we only
    // care that the x-api-key header authenticated.)
    expect(status).not.toBe(401);
    expect(body?.error?.type).not.toBe('authentication_error');
  });

  it('does not grant CORS access to arbitrary browser origins', async () => {
    const { status, headers } = await request(app, 'GET', '/api/ping', undefined, {
      Origin: 'https://attacker.example',
    });

    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the local dashboard origin through CORS', async () => {
    const { status, headers } = await request(app, 'GET', '/api/ping', undefined, {
      Origin: 'http://localhost:5173',
    });

    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
