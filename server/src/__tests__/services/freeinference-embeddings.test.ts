import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { EMBEDDING_PLATFORMS, runEmbeddings } from '../../services/embeddings.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const vector = (value = 0.1) => Array(1024).fill(value);
const row = { platform: 'freeinference', modelId: 'bge-m3', family: 'bge-m3', displayName: 'BGE-M3', dimensions: 1024, maxInputTokens: 8192, priority: 1, enabled: true, quotaLabel: 'Shared daily research quota' };
const catalog = { version: '2099.01.01', generatedAt: '2099-01-01T00:00:00Z', tier: 'live' as const, models: [], embeddings: [row], quirks: [] };
function seed() {
  const secret = encrypt('test-key');
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('freeinference','test',?,?,?,'unknown',1)").run(secret.encrypted, secret.iv, secret.authTag);
  expect(applyCatalog(getDb(), catalog).skippedUnknownPlatform).toBe(0);
}
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('FreeInference embeddings', () => {
  it.each(['bge-m3', 'BAAI/bge-m3'])('accepts the verified identity %s and validates/reorders float vectors', async model => {
    seed();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ model,
      data: [{ index: 1, embedding: vector(0.2) }, { index: 0, embedding: vector(0.1) }], usage: { prompt_tokens: 14 } }));
    const result = await runEmbeddings('bge-m3', ['first', 'second']);
    expect(EMBEDDING_PLATFORMS.has('freeinference')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://freeinference.org/v1/embeddings');
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer test-key' } });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model: 'bge-m3', input: ['first', 'second'], encoding_format: 'float' });
    expect(result).toMatchObject({ platform: 'freeinference', modelId: 'bge-m3', dimensions: 1024, inputTokens: 14 });
    expect(result.vectors.map(v => v[0])).toEqual([0.1, 0.2]);
    expect(getDb().prepare("SELECT status FROM api_keys WHERE platform='freeinference'").get()).toEqual({ status: 'healthy' });
  });
  it.each([
    null, {}, { model: 'wrong', data: [{ index: 0, embedding: vector() }] },
    { model: 'bge-m3', data: 'invalid' }, { model: 'bge-m3', data: [null] },
    { model: 'bge-m3', data: [] }, { model: 'bge-m3', data: [{ index: 0, embedding: [0.1] }] },
    { model: 'bge-m3', data: [{ index: 1, embedding: vector() }] },
    { model: 'bge-m3', data: [{ index: 0, embedding: Array(1024).fill(null) }] },
    { model: 'bge-m3', data: [{ index: 0, embedding: Array(1024).fill('0.1') }] },
  ])('rejects malformed embeddings without changing vector families', async body => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(body));
    await expect(runEmbeddings('bge-m3', ['hello'])).rejects.toMatchObject({ status: 502 });
  });
  it('rejects duplicate indices', async () => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ model: 'bge-m3', data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] }));
    await expect(runEmbeddings('bge-m3', ['first', 'second'])).rejects.toMatchObject({ status: 502 });
  });
  it('does not send unsupported dimension overrides', async () => {
    seed(); const fetch = vi.spyOn(global, 'fetch');
    await expect(runEmbeddings('bge-m3', ['hello'], 512)).rejects.toThrow('1024 dimensions');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts an explicit 1024 without sending a dimensions parameter', async () => {
    seed(); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ model: 'BAAI/bge-m3', data: [{ index: 0, embedding: vector() }] }));
    await runEmbeddings('bge-m3', ['hello'], 1024);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty('dimensions');
  });
  it('preserves upstream backoff', async () => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(new Response('limited', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(runEmbeddings('bge-m3', ['hello'])).rejects.toMatchObject({ status: 429, retryAfterMs: 30000 });
  });
  it.each([401, 403, 503])('fails closed on HTTP %s without leaking echoed secrets', async status => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(new Response('test-key', { status }));
    await expect(runEmbeddings('bge-m3', ['hello'])).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining('test-key') });
  });
  it('keeps embedding rows out of chat and preserves local disables on repeat catalog import', () => {
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM embedding_models WHERE platform='freeinference'").get()).toEqual({ n: 0 });
    seed(); applyCatalog(getDb(), catalog);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='freeinference'").get()).toEqual({ n: 0 });
    getDb().prepare("UPDATE embedding_models SET enabled=0 WHERE platform='freeinference'").run();
    applyCatalog(getDb(), catalog);
    expect(getDb().prepare("SELECT enabled FROM embedding_models WHERE platform='freeinference'").get()).toEqual({ enabled: 0 });
  });
});
