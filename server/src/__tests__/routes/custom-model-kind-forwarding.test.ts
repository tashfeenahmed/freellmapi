import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express, AddressInfo } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

const realFetch = globalThis.fetch;
let dashToken = '';

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
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

// #1506: a custom endpoint model whose id carries no media keyword but whose
// metadata (`type`/`model_type`/`object`) declares a modality. Discovery
// classifies it by that metadata, and the dashboard forwards the verdict so
// registration lands in the matching table instead of silently 404ing as chat.
describe('custom model modality forwarded from discovery (#1506)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.CATALOG_SYNC_DISABLED = '1';
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('registers a forwarded "audio" kind into media_models, not chat', async () => {
    const res = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:9090/v1',
      apiKey: 'kind-secret',
      models: [{ model: 'generic-audio-7b', kind: 'audio' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.videoSkipped).toEqual([]);
    const inMedia = getDb().prepare(
      "SELECT modality FROM media_models WHERE platform = 'custom' AND model_id = 'generic-audio-7b'",
    ).get() as { modality: string } | undefined;
    expect(inMedia?.modality).toBe('audio');
    // Must NOT have landed in the chat models table.
    expect(getDb().prepare(
      "SELECT 1 FROM models WHERE platform = 'custom' AND model_id = 'generic-audio-7b' AND endpoint_scope = 'http://127.0.0.1:9090/v1'",
    ).get()).toBeUndefined();
  });

  it('registers a forwarded "image" kind into media_models, not chat', async () => {
    const res = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:9091/v1',
      apiKey: 'kind-secret',
      models: [{ model: 'generic-image-3b', kind: 'image' }],
    });
    expect(res.status).toBe(201);
    const inMedia = getDb().prepare(
      "SELECT modality FROM media_models WHERE platform = 'custom' AND model_id = 'generic-image-3b'",
    ).get() as { modality: string } | undefined;
    expect(inMedia?.modality).toBe('image');
    expect(getDb().prepare(
      "SELECT 1 FROM models WHERE platform = 'custom' AND model_id = 'generic-image-3b' AND endpoint_scope = 'http://127.0.0.1:9091/v1'",
    ).get()).toBeUndefined();
  });

  it('routes a forwarded "video" kind to the skip list, not a chat row', async () => {
    const res = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:9092/v1',
      apiKey: 'kind-secret',
      models: [{ model: 'generic-vgen-7b', kind: 'video' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.videoSkipped).toEqual(['generic-vgen-7b']);
    expect(getDb().prepare(
      "SELECT 1 FROM models WHERE platform = 'custom' AND model_id = 'generic-vgen-7b' AND endpoint_scope = 'http://127.0.0.1:9092/v1'",
    ).get()).toBeUndefined();
  });

  it('still classifies by id when no kind is forwarded (unchanged #1051 behavior)', async () => {
    const res = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:9093/v1',
      apiKey: 'kind-secret',
      models: ['flute-tts-1'],
    });
    expect(res.status).toBe(201);
    const inMedia = getDb().prepare(
      "SELECT modality FROM media_models WHERE platform = 'custom' AND model_id = 'flute-tts-1'",
    ).get() as { modality: string } | undefined;
    expect(inMedia?.modality).toBe('audio');
  });

  // End-to-end: the dashboard discovers a metadata-only audio model, forwards
  // its kind, and the server registers it in the right table — reproducing the
  // full round trip the previous (discovery-only) change was missing.
  it('discovery -> forwarded-kind registration round-trip (#1506)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'generic-audio-7b', type: 'audio' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const dis = await post(app, '/api/keys/custom/discover-models', {
      baseUrl: 'http://127.0.0.1:9094/v1',
      apiKey: 'discover-secret',
    });
    expect(dis.status).toBe(200);
    const discovered = dis.body.models[0];
    expect(discovered?.id).toBe('generic-audio-7b');
    expect(discovered?.kind).toBe('audio');

    const reg = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:9094/v1',
      apiKey: 'discover-secret',
      models: [{ model: discovered.id, kind: discovered.kind }],
    });
    expect(reg.status).toBe(201);
    const inMedia = getDb().prepare(
      "SELECT modality FROM media_models WHERE platform = 'custom' AND model_id = 'generic-audio-7b'",
    ).get() as { modality: string } | undefined;
    expect(inMedia?.modality).toBe('audio');
    expect(getDb().prepare(
      "SELECT 1 FROM models WHERE platform = 'custom' AND model_id = 'generic-audio-7b' AND endpoint_scope = 'http://127.0.0.1:9094/v1'",
    ).get()).toBeUndefined();
  });
});
