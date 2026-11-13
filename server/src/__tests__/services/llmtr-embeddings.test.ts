import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { encrypt } from '../../lib/crypto.js';
import { EMBEDDING_PLATFORMS, runEmbeddings } from '../../services/embeddings.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const models = [
  { id: 'llmtr/embeddingmagibu-200m', dimensions: 768, maxInputTokens: 8192 },
  { id: 'liquid/lfm-2.5-embedding-350m-free', dimensions: 1024, maxInputTokens: 512 },
];
const json = (body: unknown) => new Response(JSON.stringify(body));
function seed() {
  const db = getDb(), secret = encrypt('llmtr-test-key');
  db.prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('llmtr','test',?,?,?,'healthy',1)").run(secret.encrypted, secret.iv, secret.authTag);
  const result = applyCatalog(db, { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', models: [], quirks: [],
    embeddings: models.map(model => ({ platform: 'llmtr', modelId: model.id, family: model.id, displayName: model.id, dimensions: model.dimensions,
      maxInputTokens: model.maxInputTokens, priority: 1, enabled: true, quotaLabel: 'Selected zero-price route; provider quota applies' })) });
  expect(result.skippedUnknownPlatform).toBe(0);
}

describe('LLMTR catalog-managed embeddings', () => {
  // clearAllCooldowns: a 429 benches the key, and the in-memory bench outlives the DB reset.
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(); });
  afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

  it.each(models)('routes $id with exact model identity, dimensions and usage', async model => {
    seed();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ model: model.id,
      data: [{ index: 1, embedding: Array(model.dimensions).fill(0.2) }, { index: 0, embedding: Array(model.dimensions).fill(0.1) }], usage: { prompt_tokens: 6 } }));
    const result = await runEmbeddings(model.id, ['first', 'second'], model.dimensions);
    expect(EMBEDDING_PLATFORMS.has('llmtr')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://llmtr.com/v1/embeddings');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer llmtr-test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model: model.id, input: ['first', 'second'] });
    expect(result).toMatchObject({ platform: 'llmtr', modelId: model.id, dimensions: model.dimensions, inputTokens: 6 });
    expect(result.vectors.map(v => v[0])).toEqual([0.1, 0.2]);
  });

  it.each([
    { model: 'other', data: [{ index: 0, embedding: Array(768).fill(0.1) }] },
    { data: [{ index: 0, embedding: Array(768).fill(0.1) }] },
    { model: models[0].id, data: [] },
    { model: models[0].id, data: [{ index: 0, embedding: [0.1] }] },
    { model: models[0].id, data: [{ index: 0, embedding: Array(768).fill(null) }] },
    { model: models[0].id, data: [{ index: 0, embedding: Array(768).fill('0.1') }] },
    { model: models[0].id, data: [{ index: 1, embedding: Array(768).fill(0.1) }] },
    { error: { code: 'insufficient_credits' } },
  ])('rejects malformed vectors or substituted model identity', async body => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runEmbeddings(models[0].id, ['hello'])).rejects.toMatchObject({ status: 502 });
  });

  it('rejects duplicate indexes even when the batch size matches', async () => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(json({ model: models[0].id,
      data: [{ index: 0, embedding: Array(768).fill(0.1) }, { index: 0, embedding: Array(768).fill(0.2) }] }));
    await expect(runEmbeddings(models[0].id, ['first', 'second'])).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a dimension override before sending a request', async () => {
    seed(); const fetch = vi.spyOn(global, 'fetch');
    await expect(runEmbeddings(models[0].id, ['hello'], 1024)).rejects.toThrow('dimension override');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves upstream rate-limit retry hints', async () => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream error', { status: 429, headers: { 'Retry-After': '45' } }));
    await expect(runEmbeddings(models[0].id, ['hello'])).rejects.toMatchObject({ status: 429, retryAfterMs: 45_000 });
  });

  it.each([401, 402, 503])('fails closed on upstream HTTP %i without returning vectors', async status => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream error', { status }));
    // Preserve the existing family router's normalization of exhausted chains.
    await expect(runEmbeddings(models[0].id, ['hello'])).rejects.toMatchObject({
      status: 502, message: expect.stringContaining(`upstream ${status}`),
    });
  });

  it('does not seed rows before the signed catalog arrives', () => {
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM embedding_models WHERE platform='llmtr'").get()).toEqual({ n: 0 });
  });
});
