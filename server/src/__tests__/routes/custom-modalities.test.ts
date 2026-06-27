import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

const realFetch = globalThis.fetch;

let dashToken = '';

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0);
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
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function del(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'DELETE',
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

describe('custom provider modalities', () => {
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

  it('registers a custom embedding provider after probing dimensions', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(3));
    globalThis.fetch = fetchMock as any;

    const { status, body } = await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8181/v1/',
      model: 'local-embed',
      family: 'local-family',
      displayName: 'Local Embed',
      apiKey: 'embed-secret',
    });

    expect(status).toBe(201);
    expect(body.dimensions).toBe(3);
    expect(body.baseUrl).toBe('http://127.0.0.1:8181/v1');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8181/v1/embeddings');

    const row = getDb().prepare(`
      SELECT em.family, em.model_id, em.display_name, em.dimensions, k.base_url, k.encrypted_key, k.iv, k.auth_tag
        FROM embedding_models em
        JOIN api_keys k ON k.id = em.key_id
       WHERE em.platform = 'custom' AND em.model_id = 'local-embed'
    `).get() as any;
    expect(row.family).toBe('local-family');
    expect(row.display_name).toBe('Local Embed');
    expect(row.dimensions).toBe(3);
    expect(row.base_url).toBe('http://127.0.0.1:8181/v1');
    expect(decrypt(row.encrypted_key, row.iv, row.auth_tag)).toBe('embed-secret');
  });

  it('rejects a custom embedding provider with mismatched family dimensions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(embeddingResponse(3))
      .mockResolvedValueOnce(embeddingResponse(2));
    globalThis.fetch = fetchMock as any;

    expect((await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8181/v1',
      model: 'local-embed-a',
      family: 'shared-family',
    })).status).toBe(201);

    const { status, body } = await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8282/v1',
      model: 'local-embed-b',
      family: 'shared-family',
    });

    expect(status).toBe(400);
    expect(body.error.message).toMatch(/Use a new family name/);
  });

  it('registers custom image and audio models against one endpoint key', async () => {
    const image = await post(app, '/api/media/custom', {
      baseUrl: 'http://127.0.0.1:8383/v1',
      model: 'local-image',
      modality: 'image',
      apiKey: 'media-secret',
      label: 'Local media',
    });
    const audio = await post(app, '/api/media/custom', {
      baseUrl: 'http://127.0.0.1:8383/v1',
      model: 'local-tts',
      modality: 'audio',
    });

    expect(image.status).toBe(201);
    expect(audio.status).toBe(201);
    expect(audio.body.keyId).toBe(image.body.keyId);

    const keys = getDb().prepare("SELECT * FROM api_keys WHERE platform = 'custom' AND base_url = 'http://127.0.0.1:8383/v1'").all() as any[];
    expect(keys).toHaveLength(1);
    expect(decrypt(keys[0].encrypted_key, keys[0].iv, keys[0].auth_tag)).toBe('media-secret');

    const rows = getDb().prepare(`
      SELECT model_id, modality, key_id
        FROM media_models
       WHERE platform = 'custom'
       ORDER BY model_id
    `).all() as { model_id: string; modality: string; key_id: number }[];
    expect(rows).toEqual([
      { model_id: 'local-image', modality: 'image', key_id: image.body.keyId },
      { model_id: 'local-tts', modality: 'audio', key_id: image.body.keyId },
    ]);
  });

  it('lists chat, embedding, image, and audio models under their custom endpoint key', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(3));
    globalThis.fetch = fetchMock as any;

    const chat = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:8585/v1',
      model: 'local-chat',
      displayName: 'Local Chat',
      apiKey: 'endpoint-secret',
      label: 'Local endpoint',
    });
    expect(chat.status).toBe(201);
    expect((await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8585/v1',
      model: 'local-embed',
      family: 'local-list-family',
      displayName: 'Local Embed',
    })).status).toBe(201);
    expect((await post(app, '/api/media/custom', {
      baseUrl: 'http://127.0.0.1:8585/v1',
      model: 'local-image',
      modality: 'image',
      displayName: 'Local Image',
    })).status).toBe(201);
    expect((await post(app, '/api/media/custom', {
      baseUrl: 'http://127.0.0.1:8585/v1',
      model: 'local-audio',
      modality: 'audio',
      displayName: 'Local Audio',
    })).status).toBe(201);

    const keys = await get(app, '/api/keys');
    expect(keys.status).toBe(200);
    const custom = keys.body.find((k: any) => k.platform === 'custom' && k.baseUrl === 'http://127.0.0.1:8585/v1');
    expect(custom.label).toBe('Local endpoint');
    expect(custom.models.map((m: any) => `${m.kind}:${m.modelId}`).sort()).toEqual([
      'audio:local-audio',
      'chat:local-chat',
      'embedding:local-embed',
      'image:local-image',
    ]);
    expect(custom.models.find((m: any) => m.kind === 'embedding').family).toBe('local-list-family');
  });

  it('deletes individual custom models and removes the endpoint key only when none remain', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(3));
    globalThis.fetch = fetchMock as any;

    expect((await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:8686/v1',
      model: 'local-chat',
      apiKey: 'endpoint-secret',
    })).status).toBe(201);
    expect((await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8686/v1',
      model: 'local-embed',
      family: 'local-delete-list-family',
    })).status).toBe(201);
    expect((await post(app, '/api/media/custom', {
      baseUrl: 'http://127.0.0.1:8686/v1',
      model: 'local-image',
      modality: 'image',
    })).status).toBe(201);

    const before = await get(app, '/api/keys');
    const key = before.body.find((k: any) => k.platform === 'custom' && k.baseUrl === 'http://127.0.0.1:8686/v1');
    const chat = key.models.find((m: any) => m.kind === 'chat');
    const embedding = key.models.find((m: any) => m.kind === 'embedding');
    const image = key.models.find((m: any) => m.kind === 'image');

    expect((await del(app, `/api/models/custom/${chat.id}`)).status).toBe(200);
    const afterChatDelete = await get(app, '/api/keys');
    const stillPresent = afterChatDelete.body.find((k: any) => k.id === key.id);
    expect(stillPresent.models.map((m: any) => m.kind).sort()).toEqual(['embedding', 'image']);

    expect((await del(app, `/api/embeddings/custom/${embedding.id}`)).status).toBe(200);
    expect((await del(app, `/api/media/custom/${image.id}`)).status).toBe(200);
    const afterAllDeleted = await get(app, '/api/keys');
    expect(afterAllDeleted.body.find((k: any) => k.id === key.id)).toBeUndefined();
  });

  it('deleting a custom endpoint key removes bound embedding and media models', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(3));
    globalThis.fetch = fetchMock as any;

    const embedding = await post(app, '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:8484/v1',
      model: 'local-embed',
      family: 'local-delete-family',
      apiKey: 'delete-secret',
    });
    expect(embedding.status).toBe(201);

    const media = await post(app, '/api/media/custom', {
      baseUrl: 'http://127.0.0.1:8484/v1',
      model: 'local-image',
      modality: 'image',
    });
    expect(media.status).toBe(201);
    expect(media.body.keyId).toBe(embedding.body.keyId);

    getDb().prepare("UPDATE settings SET value = 'local-delete-family' WHERE key = 'embeddings_default_family'").run();

    const removed = await del(app, `/api/keys/${embedding.body.keyId}`);
    expect(removed.status).toBe(200);

    expect((getDb().prepare("SELECT COUNT(*) AS n FROM embedding_models WHERE platform = 'custom'").get() as { n: number }).n).toBe(0);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform = 'custom'").get() as { n: number }).n).toBe(0);
    const def = getDb().prepare("SELECT value FROM settings WHERE key = 'embeddings_default_family'").get() as { value: string };
    expect(def.value).not.toBe('local-delete-family');
  });
});
