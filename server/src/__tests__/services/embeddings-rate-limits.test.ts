import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  runEmbeddings,
  embeddingRateLimitModelId,
} from '../../services/embeddings.js';
import { recordRequest, invalidateWindowUsage } from '../../services/ratelimit.js';
import { stubPublicDns } from '../helpers/dns.js';

// Fake relay hosts must resolve for the URL guard (#1875).
beforeEach(() => stubPublicDns());

const realFetch = globalThis.fetch;

function addKey(platform: string, raw = `${platform}-test-key`): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
  return Number(row.lastInsertRowid);
}

interface EmbedRow {
  family: string;
  platform: string;
  modelId: string;
  dims: number;
  priority: number;
  rpm?: number | null;
  rpd?: number | null;
  tpm?: number | null;
  tpd?: number | null;
}

function addEmbeddingRow(r: EmbedRow) {
  getDb().prepare(`
    INSERT INTO embedding_models
      (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit)
    VALUES (?, ?, ?, ?, ?, ?, 1, '', ?, ?, ?, ?)
  `).run(
    r.family, r.platform, r.modelId, r.modelId, r.dims, r.priority,
    r.rpm ?? null, r.rpd ?? null, r.tpm ?? null, r.tpd ?? null,
  );
}

function okEmbeddingResponse(dims: number, count = 1) {
  return new Response(JSON.stringify({
    data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: Array(dims).fill(0.1) })),
    usage: { prompt_tokens: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(impl: typeof fetch): MockedFunction<typeof fetch> {
  const m = vi.fn(impl) as MockedFunction<typeof fetch>;
  globalThis.fetch = m as unknown as typeof fetch;
  return m;
}

/** Spend N requests in this model's own window, exactly as a real request would. */
function spend(platform: string, modelId: string, keyId: number, n: number) {
  for (let i = 0; i < n; i += 1) recordRequest(platform, modelId, keyId);
  // The in-memory window cache is authoritative when the DB is present; drop it
  // so the next read re-counts the rows we just wrote.
  invalidateWindowUsage();
}

function usageRows(platform: string, modelId: string) {
  return getDb().prepare(`
    SELECT kind, tokens FROM rate_limit_usage
     WHERE platform = ? AND model_id = ? ORDER BY id
  `).all(platform, modelId) as { kind: string; tokens: number }[];
}

describe('embeddings rate limits', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    invalidateWindowUsage();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('skips a provider whose rpm window is spent and fails over to its sibling', async () => {
    const nvKey = addKey('nvidia');
    addKey('openrouter');
    // Same family, two providers. Only nvidia is configured, and its single
    // request is already spent — so the family must move on rather than 429.
    addEmbeddingRow({ family: 'mrl-embed', platform: 'nvidia', modelId: 'nvidia/mrl-embed', dims: 2048, priority: 1, rpm: 1 });
    addEmbeddingRow({ family: 'mrl-embed', platform: 'openrouter', modelId: 'nvidia/mrl-embed:free', dims: 2048, priority: 2 });

    spend('nvidia', embeddingRateLimitModelId('nvidia/mrl-embed'), nvKey, 1);

    const fetchMock = mockFetch(async () => okEmbeddingResponse(2048));
    const result = await runEmbeddings('mrl-embed', ['hello']);

    expect(result.platform).toBe('openrouter');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('openrouter.ai');
  });

  it('never calls upstream when every provider in the family is window-blocked', async () => {
    const nvKey = addKey('nvidia');
    const orKey = addKey('openrouter');
    addEmbeddingRow({ family: 'dry-embed', platform: 'nvidia', modelId: 'nvidia/dry-embed', dims: 8, priority: 1, rpm: 1 });
    addEmbeddingRow({ family: 'dry-embed', platform: 'openrouter', modelId: 'openrouter/dry-embed', dims: 8, priority: 2, rpm: 1 });

    spend('nvidia', embeddingRateLimitModelId('nvidia/dry-embed'), nvKey, 1);
    spend('openrouter', embeddingRateLimitModelId('openrouter/dry-embed'), orKey, 1);

    const fetchMock = mockFetch(async () => okEmbeddingResponse(8));
    const err = await runEmbeddings('dry-embed', ['hello']).catch(e => e);

    // 429 with our own reason, NOT a 502: the pool recovers by waiting.
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limit_exceeded');
    expect(err.message).toContain('rate-limited');
    // The provider is never billed for a request it would have rejected.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records the request and its tokens so the window actually advances', async () => {
    addKey('nvidia');
    addEmbeddingRow({ family: 'ledger-embed', platform: 'nvidia', modelId: 'nvidia/ledger-embed', dims: 4, priority: 1 });

    mockFetch(async () => okEmbeddingResponse(4));
    await runEmbeddings('ledger-embed', ['hello']);

    const rows = usageRows('nvidia', embeddingRateLimitModelId('nvidia/ledger-embed'));
    expect(rows.map(r => r.kind)).toEqual(['request', 'tokens']);
    // Before this change the embeddings path wrote nothing here at all, which is
    // why the provider-account minute cap could not see embedding traffic.
    expect(rows[1].tokens).toBeGreaterThan(0);
  });

  it('namespaces the per-model ledger key so a chat model of the same id cannot collide', async () => {
    // A chat model and an embedding model sharing one upstream id would compare
    // one counter against two different limit sets if they shared a window.
    const keyId = addKey('nvidia');
    addEmbeddingRow({ family: 'collide-embed', platform: 'nvidia', modelId: 'nvidia/same-id', dims: 4, priority: 1 });

    mockFetch(async () => okEmbeddingResponse(4));
    await runEmbeddings('collide-embed', ['hello']);

    expect(usageRows('nvidia', embeddingRateLimitModelId('nvidia/same-id'))).toHaveLength(2);
    // The bare id (what a chat model would use) stays untouched.
    expect(usageRows('nvidia', 'nvidia/same-id')).toHaveLength(0);
    expect(keyId).toBeGreaterThan(0);
  });

  it('counts embedding traffic against the provider-account minute cap', async () => {
    const nvKey = addKey('nvidia');
    addKey('openrouter');
    // Neither row sets its own limits: the ACCOUNT cap (nvidia: 40/min) is what
    // has to stop the request, proving embeddings reserve from the same bucket
    // the chat router uses.
    addEmbeddingRow({ family: 'acct-embed', platform: 'nvidia', modelId: 'nvidia/acct-embed', dims: 8, priority: 1 });
    addEmbeddingRow({ family: 'acct-embed', platform: 'openrouter', modelId: 'openrouter/acct-embed', dims: 8, priority: 2 });

    // Spend the whole nvidia minute on unrelated chat-shaped traffic.
    spend('nvidia', 'some/chat-model', nvKey, 40);

    const fetchMock = mockFetch(async () => okEmbeddingResponse(8));
    const result = await runEmbeddings('acct-embed', ['hello']);

    expect(result.platform).toBe('openrouter');
    expect(String(fetchMock.mock.calls[0][0])).toContain('openrouter.ai');
  });

  it('leaves rows with no configured limits behaving exactly as before', async () => {
    addKey('nvidia');
    addEmbeddingRow({ family: 'free-embed', platform: 'nvidia', modelId: 'nvidia/free-embed', dims: 4, priority: 1 });

    // Far more traffic than any sane rpm, all with NULL limits: still serves.
    const keyId = 1;
    spend('nvidia', embeddingRateLimitModelId('nvidia/free-embed'), keyId, 5);

    const fetchMock = mockFetch(async () => okEmbeddingResponse(4));
    const result = await runEmbeddings('free-embed', ['hello']);

    expect(result.platform).toBe('nvidia');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours tpm by skipping a provider whose token window is spent', async () => {
    const nvKey = addKey('nvidia');
    addKey('openrouter');
    addEmbeddingRow({ family: 'tok-embed', platform: 'nvidia', modelId: 'nvidia/tok-embed', dims: 8, priority: 1, tpm: 1 });
    addEmbeddingRow({ family: 'tok-embed', platform: 'openrouter', modelId: 'openrouter/tok-embed', dims: 8, priority: 2 });

    // One recorded request with a large token count exhausts a tpm of 1.
    getDb().prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ('nvidia', ?, ?, 'tokens', 1000000, ?)
    `).run(embeddingRateLimitModelId('nvidia/tok-embed'), nvKey, Date.now());
    invalidateWindowUsage();

    const fetchMock = mockFetch(async () => okEmbeddingResponse(8));
    const result = await runEmbeddings('tok-embed', ['hello']);

    expect(result.platform).toBe('openrouter');
    expect(String(fetchMock.mock.calls[0][0])).toContain('openrouter.ai');
  });

  it('tries a sibling key on the same native platform when the first key exhausts its per-model rpm window', async () => {
    const firstKey = addKey('nvidia', 'nv-key-1');
    addKey('nvidia', 'nv-key-2');
    addEmbeddingRow({ family: 'multi-key-embed', platform: 'nvidia', modelId: 'nvidia/multi-key-embed', dims: 8, priority: 1, rpm: 1 });

    // Exhaust key 1's per-model RPM window; key 2 is untouched.
    spend('nvidia', embeddingRateLimitModelId('nvidia/multi-key-embed'), firstKey, 1);

    const seenAuthHeaders: string[] = [];
    mockFetch(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenAuthHeaders.push(headers?.Authorization ?? headers?.authorization ?? '');
      return okEmbeddingResponse(8);
    });

    const result = await runEmbeddings('multi-key-embed', ['hello']);
    expect(result.platform).toBe('nvidia');
    expect(seenAuthHeaders).toEqual(['Bearer nv-key-2']);
  });
});
