// Registering a custom embedding endpoint against an ASYMMETRIC model
// (NVIDIA Nemotron 3.5) used to be impossible: the dimension probe went out
// with no input_type and the provider answered 400 "'input_type' parameter is
// required for asymmetric models", so the operator never got a model row at
// all — and the same 400 would have hit every later request.
//
// This exercises the whole registration surface end to end: the probe speaks
// the contract the request path will speak, the choice is stored, and it
// survives a re-submit that stays silent about it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

const realFetch = globalThis.fetch;

let dashToken = '';

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
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

async function get(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function embeddingResponse(dimensions: number) {
  return new Response(JSON.stringify({
    data: [{ index: 0, embedding: Array(dimensions).fill(0.1) }],
    usage: { prompt_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('custom embedding registration with an input_type', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('registers an asymmetric model: the probe carries the input_type', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(2048));
    globalThis.fetch = fetchMock as any;

    const { status, body } = await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8181/v1',
      model: 'nemotron-embed',
      family: 'nemotron-embed',
      displayName: 'Nemotron Embed',
      inputType: 'query',
    });

    expect(status).toBe(201);
    expect(body.dimensions).toBe(2048);
    // The probe is the request that used to fail with the upstream 400.
    const probeBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(probeBody).toMatchObject({ model: 'nemotron-embed', input_type: 'query' });

    const row = getDb().prepare(`
      SELECT input_type FROM embedding_models
       WHERE platform = 'custom' AND model_id = 'nemotron-embed'
    `).get() as { input_type: string | null };
    expect(row.input_type).toBe('query');
  });

  it('registers a symmetric model with no input_type on the wire at all', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(1024));
    globalThis.fetch = fetchMock as any;

    const { status } = await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8181/v1',
      model: 'bge-m3',
      family: 'bge-m3',
    });

    expect(status).toBe(201);
    const probeBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    // Not merely a null value — the field must be ABSENT, because symmetric
    // providers reject an unknown field.
    expect(probeBody).not.toHaveProperty('input_type');

    const row = getDb().prepare(`
      SELECT input_type FROM embedding_models
       WHERE platform = 'custom' AND model_id = 'bge-m3'
    `).get() as { input_type: string | null };
    expect(row.input_type).toBeNull();
  });

  it('keeps the stored input_type when a re-submit stays silent about it', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(2048));
    globalThis.fetch = fetchMock as any;

    expect((await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8181/v1',
      model: 'nemotron-embed',
      family: 'nemotron-embed',
      inputType: 'passage',
    })).status).toBe(201);

    // A rename or a family change must not drop the choice: the endpoint
    // answers 400 without it, so the re-submit has to speak the same contract.
    expect((await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8181/v1',
      model: 'nemotron-embed',
      family: 'nemotron-embed-v2',
    })).status).toBe(201);

    const probeBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(probeBody.input_type).toBe('passage');

    const row = getDb().prepare(`
      SELECT input_type FROM embedding_models
       WHERE platform = 'custom' AND model_id = 'nemotron-embed'
    `).get() as { input_type: string | null };
    expect(row.input_type).toBe('passage');
  });

  it('rejects an input_type the wire contract does not define', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(2048));
    globalThis.fetch = fetchMock as any;

    const { status, body } = await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8181/v1',
      model: 'nemotron-embed',
      inputType: 'search_document',
    });

    expect(status).toBe(400);
    expect(body.error.message).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists the input_type for a custom provider', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(2048));
    globalThis.fetch = fetchMock as any;

    await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8181/v1',
      model: 'nemotron-embed',
      family: 'nemotron-embed',
      inputType: 'query',
    });

    const { body } = await get(app, '/api/embeddings');
    const family = body.families.find((f: any) => f.family === 'nemotron-embed');
    const provider = family.providers.find((p: any) => p.platform === 'custom');
    expect(provider.inputType).toBe('query');
  });

  it('explains an upstream 400 that asks for an input_type', async () => {
    // The provider's own message, verbatim, so the operator sees WHY the
    // registration failed instead of a bare 400.
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: "'input_type' parameter is required for asymmetric models" }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as any;

    const { status, body } = await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8181/v1',
      model: 'nemotron-embed',
      family: 'nemotron-embed',
    });

    expect(status).toBe(400);
    expect(body.error.message).toMatch(/input_type/);
    expect(body.error.message).toMatch(/asymmetric/i);
  });
});
