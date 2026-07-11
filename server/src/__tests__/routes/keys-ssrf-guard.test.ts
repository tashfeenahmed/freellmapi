import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { proxyFetch } from '../../lib/proxy.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// SSRF guard (#440): the custom-provider base_url is the only user-supplied
// outbound target. Metadata/link-local addresses must be rejected at save
// time (POST /api/keys/custom) and again at request time (proxyFetch).

let dashToken = '';

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('POST /api/keys/custom SSRF guard (#440)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('rejects an AWS metadata base URL', async () => {
    const res = await post(app, '/api/keys/custom', {
      baseUrl: 'http://169.254.169.254/latest/meta-data',
      model: 'not-a-model',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/metadata/);
  });

  it('rejects the GCP metadata hostname', async () => {
    const res = await post(app, '/api/keys/custom', {
      baseUrl: 'http://metadata.google.internal/computeMetadata/v1',
      model: 'not-a-model',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/metadata/);
  });

  it('rejects a decimal-encoded metadata IP', async () => {
    const res = await post(app, '/api/keys/custom', {
      baseUrl: 'http://2852039166/v1', // canonicalises to 169.254.169.254
      model: 'not-a-model',
    });
    expect(res.status).toBe(400);
  });

  it('still accepts a loopback base URL by default (local Ollama)', async () => {
    const res = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:4b',
    });
    expect(res.status).toBe(201);
  });
});

describe('proxyFetch request-time SSRF guard (#440)', () => {
  it('blocks custom-platform requests to metadata addresses even when already saved', async () => {
    const spy = vi.spyOn(global, 'fetch');
    await expect(
      proxyFetch('http://169.254.169.254/latest/meta-data', undefined, 'custom', 'chat', 15_000),
    ).rejects.toThrow(/blocked.*metadata/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not re-guard built-in platforms', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}'));
    await proxyFetch('https://api.groq.com/openai/v1/models', undefined, 'groq', 'chat', 15_000);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
