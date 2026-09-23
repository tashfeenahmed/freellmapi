// A provider 429 that states when to come back must reach the client as a
// Retry-After header on BOTH embedding surfaces (/v1/embeddings and the Ollama
// emulation /api/embed). Before this, only the LOCAL monthly-budget block set
// the header; an upstream `Retry-After: 17` came back as a bare 429, so SDK
// clients retried on their own aggressive defaults and burned the tier again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

const realFetch = globalThis.fetch;

let server: Server;
let baseUrl: string;
let token: string;

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  const secret = encrypt('embed-rate-test-key');
  const keyId = Number(db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status, base_url)
    VALUES ('custom', 'embed-rate', ?, ?, ?, 1, 'healthy', 'http://embeddings.test/v1')`)
    .run(secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
  db.prepare(`INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label, key_id)
    VALUES ('rate-embed', 'custom', 'rate-embed', 'Rate embed', 2, 1, 1, '', ?)`).run(keyId);
  token = getUnifiedApiKey();
  // Ollama emulation is opt-in; /api/embed 404s until it's on.
  setSetting('ollama_emulation', 'key-required');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

function rateLimited(retryAfter: string) {
  return new Response(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'Retry-After': retryAfter },
  });
}

async function postJson(path: string, body: unknown) {
  // realFetch: globalThis.fetch is replaced with the provider mock inside each
  // test, and the request to OUR server must not be swallowed by it.
  return realFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('embedding rate-limit Retry-After propagation', () => {
  it.each(['/v1/embeddings', '/api/embed'])('%s relays the upstream Retry-After header', async (path) => {
    globalThis.fetch = vi.fn(async () => rateLimited('17')) as unknown as typeof fetch;

    const res = await postJson(path, { model: 'rate-embed', input: 'hello' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
  });

  it.each(['/v1/embeddings', '/api/embed'])('%s has no Retry-After when the upstream stated none', async (path) => {
    globalThis.fetch = vi.fn(async () => new Response('server exploded', { status: 500 })) as unknown as typeof fetch;

    const res = await postJson(path, { model: 'rate-embed', input: 'hello' });
    expect(res.status).toBe(502); // chain dry -> gateway error, not a fake 429
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it.each(['/v1/embeddings', '/api/embed'])('%s fails over past a rate-limited provider without relaying its Retry-After', async (path) => {
    // A second provider in the same family that answers fine.
    const db = getDb();
    const secret = encrypt('embed-ok-key');
    const okKey = Number(db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status, base_url)
      VALUES ('custom', 'embed-ok', ?, ?, ?, 1, 'healthy', 'http://embeddings-ok.test/v1')`)
      .run(secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
    db.prepare(`INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label, key_id)
      VALUES ('rate-embed', 'custom', 'rate-embed-ok', 'Rate embed ok', 2, 2, 1, '', ?)`).run(okKey);
    globalThis.fetch = vi.fn(async (url: string) => String(url).includes('embeddings-ok.test')
      ? new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      : rateLimited('17')) as unknown as typeof fetch;

    const res = await postJson(path, { model: 'rate-embed', input: 'hello' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('relays only Retry-After, never other upstream headers', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', {
      status: 429,
      headers: { 'Retry-After': '17', 'x-ratelimit-remaining-requests': '0', 'x-upstream-provider': 'secret-host', 'set-cookie': 'a=b' },
    })) as unknown as typeof fetch;

    const res = await postJson('/v1/embeddings', { model: 'rate-embed', input: 'hello' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
    expect(res.headers.get('x-ratelimit-remaining-requests')).toBeNull();
    expect(res.headers.get('x-upstream-provider')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
