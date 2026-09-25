// Media routes relay an upstream Retry-After only once the provider chain is
// rate limited end to end (the soonest stated delay). A single provider's 429
// is failed over and never reaches the client as a back-off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

const realFetch = globalThis.fetch;

let server: Server;
let baseUrl: string;
let token: string;

function addKey(platform: string) {
  const s = encrypt(`${platform}-media-key`);
  getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)`).run(platform, s.encrypted, s.iv, s.authTag);
}

function addMedia(platform: string, modelId: string, priority: number) {
  getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id, meta_json)
    VALUES (?, ?, ?, 'image', ?, 1, '', NULL, NULL)`).run(platform, modelId, modelId, priority);
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  addMedia('nvidia', 'black-forest-labs/flux.1-schnell', 1);
  addMedia('siliconflow', 'black-forest-labs/FLUX.1-schnell', 2);
  addKey('nvidia');
  addKey('siliconflow');
  token = getUnifiedApiKey();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

const limited = (ra?: string) => new Response('{"error":"slow down"}', {
  status: 429,
  headers: { ...(ra ? { 'Retry-After': ra } : {}), 'x-upstream-provider': 'secret-host', 'set-cookie': 'a=b' },
});

function upstream(nvidia: () => Response, siliconflow: () => Response) {
  globalThis.fetch = vi.fn(async (url: string) =>
    (String(url).includes('siliconflow') ? siliconflow() : nvidia())) as unknown as typeof fetch;
}

function generate() {
  return realFetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cat' }),
  });
}

describe('image generation Retry-After relay', () => {
  it('sends the soonest Retry-After when every provider is rate limited, and no other upstream headers', async () => {
    upstream(() => limited('60'), () => limited(new Date(Date.now() + 20_000).toUTCString()));
    const res = await generate();
    expect(res.status).toBe(429);
    const ra = Number(res.headers.get('Retry-After'));
    expect(ra).toBeGreaterThanOrEqual(18);
    expect(ra).toBeLessThanOrEqual(20);
    expect(res.headers.get('x-upstream-provider')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('clamps an absurd Retry-After to a day', async () => {
    upstream(() => limited('99999999999'), () => limited('99999999999'));
    const res = await generate();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('86400');
  });

  it('fails over past a rate-limited provider without relaying its Retry-After', async () => {
    upstream(() => limited('17'), () => new Response(JSON.stringify({ images: [{ url: 'https://x/y.png' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const res = await generate();
    expect(res.status).toBe(200);
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('sends no Retry-After when the chain also hit a non-rate-limit failure', async () => {
    upstream(() => limited('17'), () => new Response('boom', { status: 500 }));
    const res = await generate();
    expect(res.status).toBe(502);
    expect(res.headers.get('Retry-After')).toBeNull();
  });
});
