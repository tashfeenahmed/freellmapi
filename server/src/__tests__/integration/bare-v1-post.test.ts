import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

// Clients that use the configured URL verbatim (Tencent WorkBuddy's custom
// model form) POST chat requests to the bare base URL. That used to fall
// through to the dashboard SPA fallback and come back as index.html with 200.

async function req(app: Express, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: res.status, json, raw, contentType: res.headers.get('content-type') ?? '' };
}

const chat = { model: 'auto', messages: [{ role: 'user', content: 'hello' }] };

describe('POST to the bare /v1 base URL', () => {
  let app: Express;
  let auth: Record<string, string>;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    getDb().prepare('DELETE FROM api_keys').run();
    auth = { Authorization: `Bearer ${getUnifiedApiKey()}` };
  });

  it.each(['/v1', '/v1/'])('%s is handled as /v1/chat/completions', async (path) => {
    const bare = await req(app, 'POST', path, chat, auth);
    const full = await req(app, 'POST', '/v1/chat/completions', chat, auth);
    expect(bare.contentType).toContain('application/json');
    expect(bare.status).toBe(full.status);
    expect(bare.json?.error?.type).toBe(full.json?.error?.type);
  });

  it('still requires the unified API key', async () => {
    const res = await req(app, 'POST', '/v1', chat, { Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
    expect(res.json?.error?.type).toBe('authentication_error');
  });

  it('unknown /v1 paths answer with a JSON 404 naming the right URL', async () => {
    const res = await req(app, 'POST', '/v1/not-a-real-endpoint', chat, auth);
    expect(res.status).toBe(404);
    expect(res.json?.error?.code).toBe('unknown_endpoint');
    expect(res.json?.error?.message).toContain('/v1/chat/completions');
  });
});
