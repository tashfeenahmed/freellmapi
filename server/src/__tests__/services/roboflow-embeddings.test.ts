import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { EMBEDDING_PLATFORMS, runEmbeddings } from '../../services/embeddings.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const vector = (value = 0.1) => Array(1024).fill(value);
const row = { platform: 'roboflow', modelId: 'clip/RN50', family: 'clip/RN50', displayName: 'CLIP RN50', dimensions: 1024, maxInputTokens: 77, priority: 1, enabled: true, quotaLabel: 'Shared daily research quota' };
const catalog = { version: '2099.01.01', generatedAt: '2099-01-01T00:00:00Z', tier: 'live' as const, models: [], embeddings: [row], quirks: [] };
function seed() {
  const secret = encrypt('test-key');
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('roboflow','test',?,?,?,'unknown',1)").run(secret.encrypted, secret.iv, secret.authTag);
  expect(applyCatalog(getDb(), catalog).skippedUnknownPlatform).toBe(0);
}
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Roboflow text embeddings', () => {
  it('preserves batch order and verifies the exact checkpoint, even for models with the same vector size', async () => {
    seed(); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({
      resolved_model: { model_id: row.modelId }, embeddings: [vector(0.2), vector(0.5)],
    }));
    const out = await runEmbeddings(row.modelId, ['dog', 'road']);
    expect(EMBEDDING_PLATFORMS.has('roboflow')).toBe(true);
    expect(out.vectors.map(v => v[0])).toEqual([0.2, 0.5]);
    expect(fetch.mock.calls[0][0]).toBe('https://serverless.roboflow.com/clip/embed_text');
    const options = fetch.mock.calls[0][1];
    expect(options).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer test-key' } });
    expect(JSON.parse(String(options?.body))).toEqual({ id: expect.any(String), model_id: row.modelId, clip_version_id: 'RN50', text: ['dog', 'road'] });
  });
  it.each([
    { resolved_model: { model_id: 'clip/RN50x64' }, embeddings: [vector()] },
    { embeddings: [vector()] },
    { resolved_model: { model_id: row.modelId }, embeddings: [vector(), vector()] },
    { resolved_model: { model_id: row.modelId }, embeddings: [[1]] },
    { resolved_model: { model_id: row.modelId }, embeddings: [Array(1024).fill(null)] },
  ])('refuses unusable or substituted vectors', async response => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(response));
    await expect(runEmbeddings(row.modelId, ['a'])).rejects.toMatchObject({ status: 502 });
  });
  it('does not request unsupported dimensions or seed any chat models', async () => {
    seed(); const fetch = vi.spyOn(global, 'fetch');
    await expect(runEmbeddings(row.modelId, ['a'], 32)).rejects.toThrow('native dimensions');
    expect(fetch).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='roboflow'").get()).toEqual({ n: 0 });
  });
});
