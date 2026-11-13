import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { clearLastHealthyStampState } from '../../services/health.js';
import { runEmbeddings } from '../../services/embeddings.js';
import { runRerank } from '../../services/rerank.js';
import { runDecision } from '../../services/decision.js';
import { runImageGeneration } from '../../services/media.js';
import { seedDecisionModels } from '../helpers/decision-models.js';

// A served request is the strongest "this key works" evidence there is, and
// every surface that spends a key from the 'healthy'/'unknown' pool must act
// on it: the chat fallback loop (#1493) and a served search (#1612) already
// do. Embeddings, rerank, decisions and media draw from the SAME pool via
// reserveProviderCredential / the rerank candidates query, yet a success there
// left the key frozen at 'unknown' — and for a provider whose keys never get
// polled (#1599/#1459) or a key demoted by an earlier blip, there was no way
// back to 'healthy' short of a manual "Check now".

const realFetch = globalThis.fetch;

function addKey(platform: string, status: 'healthy' | 'unknown', baseUrl?: string, raw = `${platform}-test-key`): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = baseUrl
    ? getDb().prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES (?, 'test', ?, ?, ?, ?, 1, ?)
      `).run(platform, encrypted, iv, authTag, status, baseUrl)
    : getDb().prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, 'test', ?, ?, ?, ?, 1)
      `).run(platform, encrypted, iv, authTag, status);
  return Number(row.lastInsertRowid);
}

function keyState(id: number) {
  return getDb().prepare('SELECT status, last_healthy_at FROM api_keys WHERE id = ?').get(id) as
    { status: string; last_healthy_at: string | null };
}

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(String(url), init)));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('a served non-chat request marks its key as working (#1493, #1612)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    clearLastHealthyStampState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('embeddings: a served embedding promotes an unknown key', async () => {
    const keyId = addKey('custom', 'unknown', 'https://embeddings.example/v1');
    getDb().prepare(`INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label, key_id)
      VALUES ('probe-embed', 'custom', 'probe-embed', 'Probe embedding', 2, 1, 1, '', ?)`).run(keyId);
    mockFetch(() => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(runEmbeddings('probe-embed', ['hello'])).resolves.toMatchObject({ platform: 'custom' });
    expect(keyState(keyId)).toMatchObject({ status: 'healthy', last_healthy_at: expect.any(String) });
  });

  it('embeddings: a failed embedding does not', async () => {
    const keyId = addKey('custom', 'unknown', 'https://embeddings.example/v1');
    getDb().prepare(`INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label, key_id)
      VALUES ('probe-embed', 'custom', 'probe-embed', 'Probe embedding', 2, 1, 1, '', ?)`).run(keyId);
    mockFetch(() => new Response('boom', { status: 500 }));

    await expect(runEmbeddings('probe-embed', ['hello'])).rejects.toThrow();
    expect(keyState(keyId)).toEqual({ status: 'unknown', last_healthy_at: null });
  });

  it('rerank: a served rerank promotes an unknown key', async () => {
    const keyId = addKey('cohere', 'unknown');
    mockFetch(() => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 }));

    await expect(runRerank(undefined, 'q', ['a', 'b'], 1)).resolves.toMatchObject({ platform: 'cohere' });
    expect(keyState(keyId)).toMatchObject({ status: 'healthy', last_healthy_at: expect.any(String) });
  });

  it('rerank: success and failure both land in the requests table', async () => {
    addKey('cohere', 'healthy');
    const requests = () => getDb().prepare(
      "SELECT status, request_type, model_id, input_tokens FROM requests WHERE request_type = 'rerank' ORDER BY id",
    ).all() as Array<{ status: string; request_type: string; model_id: string; input_tokens: number }>;

    mockFetch(() => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 }));
    await runRerank(undefined, 'query text', ['doc a', 'doc b'], 1);
    expect(requests()).toEqual([{ status: 'success', request_type: 'rerank', model_id: 'rerank-v3.5', input_tokens: expect.any(Number) }]);

    mockFetch(() => new Response('boom', { status: 500 }));
    await expect(runRerank(undefined, 'q', ['a'])).rejects.toThrow();
    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toMatchObject({ status: 'error', request_type: 'rerank', model_id: 'rerank-v3.5', input_tokens: 0 });
  });

  it('decision: a served decision promotes an unknown key', async () => {
    seedDecisionModels();
    const keyId = addKey('cloudflare', 'unknown', undefined, 'acct123:cf-token');
    mockFetch(() => new Response(JSON.stringify({
      success: true,
      result: {
        model: 'clef-flash',
        answers: { tier: { type: 'choice', choice: 'code', probabilities: { light: 0.02, code: 0.98 } } },
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await runDecision(
      { state: 'x', questions: { tier: { type: 'choice', instructions: 'i', criteria: { light: 'a', code: 'b' } } } },
      { model: '@cf/cloudflare/clef-flash', clientAgent: null },
    );
    expect(keyState(keyId)).toMatchObject({ status: 'healthy', last_healthy_at: expect.any(String) });
  });

  it('media: a served image generation promotes an unknown key', async () => {
    const keyId = addKey('nvidia', 'unknown');
    getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id, meta_json)
      VALUES ('nvidia', 'black-forest-labs/flux.1-schnell', 'flux', 'image', 1, 1, '', ?, NULL)`).run(keyId);
    mockFetch(() => new Response(JSON.stringify({ artifacts: [{ base64: 'AAAA' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(runImageGeneration('auto', { prompt: 'a cat' })).resolves.toMatchObject({ platform: 'nvidia' });
    expect(keyState(keyId)).toMatchObject({ status: 'healthy', last_healthy_at: expect.any(String) });
  });

  it('media: a failed image generation does not', async () => {
    const keyId = addKey('nvidia', 'unknown');
    getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id, meta_json)
      VALUES ('nvidia', 'black-forest-labs/flux.1-schnell', 'flux', 'image', 1, 1, '', ?, NULL)`).run(keyId);
    mockFetch(() => new Response('unavailable', { status: 503 }));

    await expect(runImageGeneration('auto', { prompt: 'a cat' })).rejects.toThrow();
    expect(keyState(keyId)).toEqual({ status: 'unknown', last_healthy_at: null });
  });
});
