import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { encrypt } from '../../lib/crypto.js';
import { EMBEDDING_PLATFORMS, runEmbeddings } from '../../services/embeddings.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const models = [
  ['nvidia-nemotron-3-embed-8b', 4096],
  ['qwen3-embedding-0-6b', 1024],
  ['qwen3-embedding-4b', 2560],
  ['qwen3-embedding-8b', 4096],
] as const;
const json = (body: unknown) => new Response(JSON.stringify(body));

function seed(model: string, dimensions: number) {
  const db = getDb(), secret = encrypt('inferbase-test-key');
  db.prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('inferbase','test',?,?,?,'healthy',1)").run(secret.encrypted, secret.iv, secret.authTag);
  const result = applyCatalog(db, {
    version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', models: [], quirks: [],
    embeddings: [{ platform: 'inferbase', modelId: model, family: 'inferbase-test', displayName: model,
      dimensions, maxInputTokens: null, priority: 1, enabled: true, quotaLabel: 'Shared free managed allowance' }],
  });
  expect(result.skippedUnknownPlatform).toBe(0);
}

describe('Inferbase catalog-managed embeddings', () => {
  // clearAllCooldowns: a 429 benches the key, and the in-memory bench outlives the DB reset.
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(); });
  afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

  it.each(models)('routes %s with float vectors, input ordering and token usage', async (model, dimensions) => {
    seed(model, dimensions);
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ model,
      data: [{ index: 1, embedding: Array(dimensions).fill(0.2) }, { index: 0, embedding: Array(dimensions).fill(0.1) }],
      usage: { prompt_tokens: 10, total_tokens: 10, cost_micros: 0 },
    }));
    const result = await runEmbeddings('inferbase-test', ['first', 'second']);
    expect(EMBEDDING_PLATFORMS.has('inferbase')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.inferbase.ai/v1/embeddings');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer inferbase-test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, input: ['first', 'second'], encoding_format: 'float' });
    expect(result).toMatchObject({ platform: 'inferbase', modelId: model, dimensions, inputTokens: 10 });
    expect(result.vectors.map(vector => vector[0])).toEqual([0.1, 0.2]);
  });

  it('forwards and validates an explicit dimension override', async () => {
    seed('qwen3-embedding-4b', 2560);
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ model: 'qwen3-embedding-4b',
      data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { total_tokens: 3 },
    }));
    expect(await runEmbeddings('inferbase-test', ['hello'], 2)).toMatchObject({ dimensions: 2, inputTokens: 3 });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).dimensions).toBe(2);
  });

  it.each([
    { model: 'other-model', data: [{ index: 0, embedding: [0.1, 0.2] }] },
    { data: [{ index: 0, embedding: [0.1, 0.2] }] },
    { model: 'test', data: [] },
    { model: 'test', data: [{ index: 0, embedding: [0.1] }] },
    { model: 'test', data: [{ index: 0, embedding: [0.1, null] }] },
    { model: 'test', data: [{ index: 0, embedding: ['0.1', '0.2'] }] },
    { model: 'test', data: [{ embedding: [0.1, 0.2] }] },
    { model: 'test', data: [{ index: 1, embedding: [0.1, 0.2] }] },
    { error: { message: 'quota exhausted' } },
  ])('rejects mismatched identities and invalid vectors instead of corrupting the family', async body => {
    seed('test', 2);
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runEmbeddings('inferbase-test', ['hello'])).rejects.toMatchObject({ status: 502 });
  });

  it('rejects duplicate vector indices', async () => {
    seed('test', 2);
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ model: 'test', data: [
      { index: 0, embedding: [0.1, 0.2] }, { index: 0, embedding: [0.3, 0.4] },
    ] }));
    await expect(runEmbeddings('inferbase-test', ['first', 'second'])).rejects.toMatchObject({ status: 502 });
  });

  it('preserves upstream rate-limit retry hints', async () => {
    seed('test', 2);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream error', { status: 429, headers: { 'Retry-After': '20' } }));
    await expect(runEmbeddings('inferbase-test', ['hello'])).rejects.toMatchObject({ status: 429, retryAfterMs: 20_000 });
  });

  it.each([401, 402, 503])('fails closed on upstream HTTP %s without returning vectors', async status => {
    seed('test', 2);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream error', { status }));
    // The existing family router normalizes exhausted non-rate-limit failures
    // to 502, retaining the upstream status in its diagnostic message.
    await expect(runEmbeddings('inferbase-test', ['hello'])).rejects.toMatchObject({
      status: 502, message: expect.stringContaining(`upstream ${status}`),
    });
  });

  it('does not seed catalog models before their signed feed arrives', () => {
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM embedding_models WHERE platform='inferbase'").get()).toEqual({ n: 0 });
  });
});
