import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { runSearch, SearchError } from '../../services/search.js';
import { getMonthlyUsage } from '../../services/key-budget.js';
import { seedSearchEngines } from '../helpers/search-engines.js';

// POST /v1/search spends real provider quota (credits per query on Tavily,
// credits on Exa et al.), but logSearch only wrote search_requests. The
// per-key monthly caps (#1158) and GET /v1/usage read key_monthly_usage,
// which the requests_key_monthly_usage trigger feeds from `requests` — so a
// capped key never accrued search spend and served searches forever past its
// cap. This is the rerank gap (#1621/#1627) on the search surface.

const realFetch = globalThis.fetch;

function addKey(platform: string, monthlyRequestCap = 0): number {
  const { encrypted, iv, authTag } = encrypt(`${platform}-test-key`);
  const row = getDb().prepare(`
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

const hits = () => new Response(JSON.stringify({
  results: [{ title: 'A', url: 'https://a', text: 'alpha' }],
}), { status: 200 });

describe('search spend lands in the requests ledger (#1158)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedSearchEngines();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('a served search writes a success row and counts toward the monthly ledger', async () => {
    const key = addKey('exa');
    globalThis.fetch = vi.fn(async () => hits()) as unknown as typeof fetch;

    const out = await runSearch('what is the weather');
    expect(out.provider).toBe('exa');

    const row = getDb().prepare(
      "SELECT platform, model_id, status, request_type, input_tokens FROM requests WHERE key_id = ?",
    ).get(key) as any;
    expect(row).toMatchObject({
      platform: 'exa', model_id: 'exa-search', status: 'success',
      request_type: 'search', input_tokens: Math.ceil('what is the weather'.length / 4),
    });
    // The trigger on requests feeds key_monthly_usage, which the caps and
    // /v1/usage read: the search is now visible to both.
    expect(getMonthlyUsage(key).requests).toBe(1);
  });

  it('a failed attempt logs an error row that does NOT count toward usage', async () => {
    const key = addKey('exa');
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })) as unknown as typeof fetch;

    await expect(runSearch('q')).rejects.toBeInstanceOf(SearchError);

    const row = getDb().prepare(
      "SELECT status, request_type FROM requests WHERE key_id = ?",
    ).get(key) as any;
    expect(row).toMatchObject({ status: 'error', request_type: 'search' });
    expect(getMonthlyUsage(key)).toEqual({ requests: 0, tokens: 0 });
  });

  it('a key at its monthly request cap is skipped; a capped-only chain 429s without touching upstream', async () => {
    const key = addKey('exa', 1);
    spendRequests(key, 1);
    const fetch = vi.fn(async () => hits());
    globalThis.fetch = fetch as unknown as typeof fetch;

    const err = await runSearch('q').catch(e => e) as SearchError;
    expect(err).toBeInstanceOf(SearchError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('quota_exceeded');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('spend accumulates until the cap bites (end-to-end cap enforcement)', async () => {
    const key = addKey('exa', 2);
    globalThis.fetch = vi.fn(async () => hits()) as unknown as typeof fetch;

    await runSearch('q1');
    await runSearch('q2');
    expect(getMonthlyUsage(key).requests).toBe(2);

    const err = await runSearch('q3').catch(e => e) as SearchError;
    expect(err.status).toBe(429);
    expect(err.code).toBe('quota_exceeded');
  });
});
