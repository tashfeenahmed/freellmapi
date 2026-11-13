import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runRerank, RerankError } from '../../services/rerank.js';
import { getMonthlyUsage } from '../../services/key-budget.js';

// POST /v1/rerank spends real provider quota, so a key at its monthly cap
// (#1158) must not serve one. Chat (router), embeddings, media, search and
// moderation all gate on the caps before dispatch; rerank read api_keys
// directly and skipped the gate — while rerankRetryAfterSec already answered
// a `quota_exceeded` code that nothing could ever set.

const realFetch = globalThis.fetch;

function addKey(platform: string, monthlyRequestCap: number, baseUrl: string | null = null): number {
  const { encrypted, iv, authTag } = encrypt(`${platform}-test-key`);
  const row = baseUrl
    ? getDb().prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, monthly_request_cap)
        VALUES (?, 'test', ?, ?, ?, 'healthy', 1, ?, ?)
      `).run(platform, encrypted, iv, authTag, baseUrl, monthlyRequestCap)
    : getDb().prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, monthly_request_cap)
        VALUES (?, 'test', ?, ?, ?, 'healthy', 1, ?)
      `).run(platform, encrypted, iv, authTag, monthlyRequestCap);
  return Number(row.lastInsertRowid);
}

function spendRequests(keyId: number, requests: number) {
  getDb().prepare(
    'INSERT INTO key_monthly_usage (key_id, month, requests, tokens) VALUES (?, ?, ?, 10)',
  ).run(keyId, new Date().toISOString().slice(0, 7), requests);
}

const ok = (results: unknown) => new Response(JSON.stringify({ results }), { status: 200 });

describe('rerank honors the per-key monthly budget (#1158)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('skips a capped key and serves from an uncapped one', async () => {
    addKey('cohere', 1);
    const capped = getDb().prepare("SELECT id FROM api_keys WHERE platform = 'cohere'").get() as { id: number };
    spendRequests(capped.id, 1);
    addKey('custom', 0, 'https://relay.example/v1');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(ok([{ index: 0, relevance_score: 0.5 }]));

    const out = await runRerank(undefined, 'q', ['a', 'b'], 1);
    expect(out.platform).toBe('custom');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('relay.example');
  });

  it('a capped-only chain answers 429 quota_exceeded, not a 502', async () => {
    const key = addKey('cohere', 1);
    spendRequests(key, 1);
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(ok([{ index: 0, relevance_score: 0.5 }]));

    const err = await runRerank(undefined, 'q', ['a'], 1).catch(e => e) as RerankError;
    expect(err).toBeInstanceOf(RerankError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('quota_exceeded');
    // The capped key was never touched upstream.
    expect(fetch).not.toHaveBeenCalled();
    expect(getMonthlyUsage(key)).toEqual({ requests: 1, tokens: 10 });
  });

  it('an uncapped chain still serves normally (regression)', async () => {
    addKey('cohere', 0);
    vi.spyOn(global, 'fetch').mockResolvedValue(ok([{ index: 1, relevance_score: 0.9 }]));
    const out = await runRerank(undefined, 'q', ['a', 'b'], 1);
    expect(out.platform).toBe('cohere');
    expect(out.results).toEqual([{ index: 1, relevanceScore: 0.9, document: 'b' }]);
  });
});
