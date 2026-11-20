import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

// #1956: Claude Desktop's gateway (and any Anthropic-style client) appends
// `/v1/...` to the base URL. Users who paste the OpenAI-style base URL
// (`.../v1`) end up calling `/v1/v1/models`, which used to 404. The doubled
// prefix must now reach the same handler as the canonical path.

async function request(app: Express, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, raw: await res.text() };
  } finally {
    server.close();
  }
}

describe('doubled /v1 prefix (#1956)', () => {
  let app: Express;
  const bearer = () => ({ Authorization: `Bearer ${getUnifiedApiKey()}` });

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('serves GET /v1/v1/models exactly like GET /v1/models', async () => {
    const canonical = await request(app, 'GET', '/v1/models', bearer());
    const doubled = await request(app, 'GET', '/v1/v1/models', bearer());
    expect(canonical.status).toBe(200);
    expect(doubled.status).toBe(200);
    expect(JSON.parse(doubled.raw)).toEqual(JSON.parse(canonical.raw));
  });

  it('keeps auth on the rewritten path (no key → 401, not 404 and not 200)', async () => {
    const doubled = await request(app, 'GET', '/v1/v1/models');
    expect(doubled.status).toBe(401);
  });

  it('routes the Anthropic Messages endpoint under the doubled prefix', async () => {
    // Missing key: the Anthropic router answers 401 rather than a 404 from
    // nothing matching, proving the request reached /v1/messages.
    const res = await request(app, 'POST', '/v1/v1/messages', { 'anthropic-version': '2023-06-01' }, {
      model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(401);
  });

  it('preserves the query string', async () => {
    const canonical = await request(app, 'GET', '/v1/models?execution_status=ready', bearer());
    const doubled = await request(app, 'GET', '/v1/v1/models?execution_status=ready', bearer());
    expect(doubled.status).toBe(canonical.status);
    expect(JSON.parse(doubled.raw)).toEqual(JSON.parse(canonical.raw));
  });

  it('does not rewrite paths that only start with the same characters', async () => {
    // `/v1/v1beta/...` is not a doubled prefix; it must not become `/v1beta/...`.
    const res = await request(app, 'GET', '/v1/v1beta/models', bearer());
    expect(res.status).toBe(404);
  });
});
