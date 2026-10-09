import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { EMBEDDING_PLATFORMS, runEmbeddings } from '../../services/embeddings.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const models = [
  ['text-embedding-3-small', 1536], ['text-embedding-3-large', 3072],
  ['codestral-embed', 1536], ['mistral-embed', 1024], ['gemini-embedding-2', 3072],
] as const;
const json = (body: unknown) => new Response(JSON.stringify(body));
function seed(model: string, dimensions: number) {
  const db = getDb(), secret = encrypt('electronhub-test-key');
  db.prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('electronhub','test',?,?,?,'healthy',1)").run(secret.encrypted, secret.iv, secret.authTag);
  const result = applyCatalog(db, { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', models: [], quirks: [],
    embeddings: [{ platform: 'electronhub', modelId: model, family: 'eh-test', displayName: model, dimensions, maxInputTokens: null, priority: 1, enabled: true, quotaLabel: '$0.25/week shared' }] });
  expect(result.skippedUnknownPlatform).toBe(0);
}

describe('ElectronHub catalog-managed embeddings', () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
  afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

  it.each(models)('routes %s with float vectors, sorted input order and usage', async (model, dimensions) => {
    seed(model, dimensions);
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ model, data: [{ index: 1, embedding: Array(dimensions).fill(0.2) }, { index: 0, embedding: Array(dimensions).fill(0.1) }], usage: { prompt_tokens: 4 } }));
    const result = await runEmbeddings('eh-test', ['first', 'second']);
    expect(EMBEDDING_PLATFORMS.has('electronhub')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.electronhub.ai/v1/embeddings');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer electronhub-test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, input: ['first', 'second'], encoding_format: 'float' });
    expect(result).toMatchObject({ platform: 'electronhub', modelId: model, dimensions, inputTokens: 4 });
    expect(result.vectors.map(v => v[0])).toEqual([0.1, 0.2]);
  });

  it('forwards and validates an explicit dimensions override', async () => {
    seed('text-embedding-3-small', 1536);
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ model: 'text-embedding-3-small', data: [{ index: 0, embedding: [0.1, 0.2] }] }));
    expect((await runEmbeddings('eh-test', ['hello'], 2)).dimensions).toBe(2);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).dimensions).toBe(2);
  });

  it.each([
    { model: 'wrong', data: [{ index: 0, embedding: [0.1, 0.2] }] },
    { data: [{ index: 0, embedding: [0.1, 0.2] }] },
    { model: 'test', data: [{ index: 0, embedding: [0.1] }] },
    { model: 'test', data: [{ index: 0, embedding: [0.1, null] }] },
    { model: 'test', data: [{ index: 1, embedding: [0.1, 0.2] }] },
  ])('rejects model substitution, invalid dimensions and malformed vectors', async body => {
    seed('test', 2);
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runEmbeddings('eh-test', ['hello'])).rejects.toMatchObject({ status: 502 });
  });

  it('preserves rate-limit retry hints', async () => {
    seed('test', 2);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Rate limited', { status: 429, headers: { 'Retry-After': '20' } }));
    await expect(runEmbeddings('eh-test', ['hello'])).rejects.toMatchObject({ status: 429, retryAfterMs: 20_000 });
  });
});
