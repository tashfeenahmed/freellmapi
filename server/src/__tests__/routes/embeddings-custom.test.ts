import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// The custom-embedding route probes the user's endpoint (fetch to its base_url)
// before persisting. We mock global fetch to serve that probe a fixed-dimension
// vector while letting requests to the local test server (127.0.0.1) hit the
// real network. `probeDims` is set per-test to control what the endpoint
// "returns".
const realFetch = globalThis.fetch;
let probeDims = 768;
let dashToken = '';
let lastProbeAuth = ''; // Authorization header the probe request was sent with

function okEmbeddingResponse(dims: number) {
  return new Response(JSON.stringify({
    data: [{ index: 0, embedding: Array(dims).fill(0.1) }],
    usage: { prompt_tokens: 1 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function req(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('POST /api/embeddings/custom', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    // Probe requests (anything that isn't the local app server) get a vector.
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).includes('127.0.0.1')) return realFetch(url, init);
      lastProbeAuth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      return okEmbeddingResponse(probeDims);
    }) as any;
  });

  afterAll(() => { globalThis.fetch = realFetch; });
  afterEach(() => { probeDims = 768; });

  it('rejects an invalid base URL', async () => {
    const { status } = await req(app, 'POST', '/api/embeddings/custom', { baseUrl: 'nope', model: 'm' });
    expect(status).toBe(400);
  });

  it('registers a new endpoint as its own family with the probed dimension', async () => {
    probeDims = 1234;
    const { status, body } = await req(app, 'POST', '/api/embeddings/custom', {
      baseUrl: 'https://embed.example/v1/',
      model: 'my-embed',
    });
    expect(status).toBe(201);
    expect(body.family).toBe('my-embed');
    expect(body.dimensions).toBe(1234);

    // It shows up on the Embeddings tab as a standalone, custom family.
    const list = await req(app, 'GET', '/api/embeddings');
    const fam = list.body.families.find((f: any) => f.family === 'my-embed');
    expect(fam).toBeDefined();
    expect(fam.dimensions).toBe(1234);
    expect(fam.providers[0].isCustom).toBe(true);
  });

  it('rejects joining an existing family when the dimension mismatches', async () => {
    probeDims = 512; // bge-m3 is 1024-dim
    const { status, body } = await req(app, 'POST', '/api/embeddings/custom', {
      baseUrl: 'https://embed.example/v1',
      model: 'self-hosted-bge',
      family: 'bge-m3',
    });
    expect(status).toBe(400);
    expect(body.error.message).toContain('1024');
  });

  it('joins an existing family at the back of the chain when dimensions match', async () => {
    probeDims = 1024; // matches bge-m3
    const { status } = await req(app, 'POST', '/api/embeddings/custom', {
      baseUrl: 'https://embed.example/v1',
      model: 'self-hosted-bge',
      family: 'bge-m3',
    });
    expect(status).toBe(201);

    const list = await req(app, 'GET', '/api/embeddings');
    const fam = list.body.families.find((f: any) => f.family === 'bge-m3');
    const custom = fam.providers.find((p: any) => p.modelId === 'self-hosted-bge');
    expect(custom).toBeDefined();
    expect(custom.isCustom).toBe(true);
    // Last in the family's chain (highest priority number among its providers).
    expect(custom.priority).toBe(Math.max(...fam.providers.map((p: any) => p.priority)));
  });

  it('reuses an existing endpoint key when a second model is added with a blank key', async () => {
    // First model carries the real key for the endpoint.
    await req(app, 'POST', '/api/embeddings/custom', {
      baseUrl: 'https://shared.example/v1',
      model: 'embed-a',
      apiKey: 'sk-shared',
    });
    // Second model on the SAME endpoint, key left blank.
    lastProbeAuth = '';
    const { status } = await req(app, 'POST', '/api/embeddings/custom', {
      baseUrl: 'https://shared.example/v1',
      model: 'embed-b',
    });
    expect(status).toBe(201);
    // The probe for the second model must have used the stored key, not a sentinel.
    expect(lastProbeAuth).toBe('Bearer sk-shared');

    // And the endpoint still has exactly one key row, still holding sk-shared.
    const { getDb } = await import('../../db/index.js');
    const { decrypt } = await import('../../lib/crypto.js');
    const rows = getDb().prepare("SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'custom' AND base_url = 'https://shared.example/v1'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(decrypt(rows[0].encrypted_key, rows[0].iv, rows[0].auth_tag)).toBe('sk-shared');
  });

  it('deletes a custom embedding provider', async () => {
    probeDims = 768;
    const created = await req(app, 'POST', '/api/embeddings/custom', {
      baseUrl: 'https://embed.example/v1',
      model: 'doomed',
    });
    const del = await req(app, 'DELETE', `/api/embeddings/custom/${created.body.id}`);
    expect(del.status).toBe(200);
    const list = await req(app, 'GET', '/api/embeddings');
    expect(list.body.families.find((f: any) => f.family === 'doomed')).toBeUndefined();
  });
});
