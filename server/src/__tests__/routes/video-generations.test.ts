import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

const realFetch = globalThis.fetch;

async function post(app: Express, body: unknown, authenticated = true) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const response = await realFetch(`http://127.0.0.1:${address.port}/v1/videos/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${getUnifiedApiKey()}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  server.close();
  return { response, bytes };
}

describe('POST /v1/videos/generations', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    const { encrypted, iv, authTag } = encrypt('sk_pollinations_video_test');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('pollinations', 'video test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
    getDb().prepare(`
      INSERT INTO media_models
        (platform, model_id, display_name, modality, priority, enabled, quota_label)
      VALUES ('pollinations', 'nova-reel', 'Nova Reel', 'video', 0, 1, 'Recurring daily Pollen refill')
    `).run();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('requires the unified API key', async () => {
    const { response } = await post(app, { prompt: 'a sunrise' }, false);
    expect(response.status).toBe(401);
  });

  it('returns the completed MP4 and routing headers', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('https://gen.pollinations.ai/video/')) {
        return new Response(Buffer.from('VIDEO'), {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      }
      return realFetch(input);
    }) as any;

    const { response, bytes } = await post(app, {
      model: 'nova-reel',
      prompt: 'a sunrise',
      duration: 6,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('video/mp4');
    expect(response.headers.get('x-provider')).toBe('pollinations');
    expect(response.headers.get('x-model')).toBe('nova-reel');
    expect(bytes.toString()).toBe('VIDEO');
  });

  it('validates provider-independent request options before routing', async () => {
    const { response, bytes } = await post(app, {
      prompt: 'a sunrise',
      duration: 121,
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(bytes.toString()).error.type).toBe('invalid_request_error');
  });
});
