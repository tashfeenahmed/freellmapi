import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  recordQuotaObservation,
  getQuotaStateForKeys,
  parseQuotaObservationsFromResponse,
  inferQuotaPoolKey,
} from '../../services/provider-quota.js';

function insertState(row: {
  platform: string;
  keyId: number;
  pool: string;
  metric: string;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}) {
  getDb().prepare(`
    INSERT INTO provider_quota_state
      (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.platform, row.keyId, row.pool, row.metric, row.limit, row.remaining, row.resetAt);
}

function readState(platform: string, keyId: number, pool: string, metric: string) {
  return getDb().prepare(`
    SELECT limit_value AS lim, remaining_value AS remaining, reset_at AS resetAt
      FROM provider_quota_state
     WHERE platform = ? AND key_id = ? AND quota_pool_key = ? AND metric = ?
  `).get(platform, keyId, pool, metric) as { lim: number | null; remaining: number | null; resetAt: string | null } | undefined;
}

describe('provider-quota: pool inference', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('buckets shared-pool providers per account and openrouter free vs account', () => {
    expect(inferQuotaPoolKey('groq')).toBe('groq::account');
    expect(inferQuotaPoolKey('openrouter', 'meta-llama/llama-3.1-8b-instruct:free')).toBe('openrouter::free');
    expect(inferQuotaPoolKey('openrouter', 'openai/gpt-4o')).toBe('openrouter::account');
    // Unknown platform falls back to platform::model or platform::account.
    expect(inferQuotaPoolKey('acme' as any, 'x')).toBe('acme::x');
    expect(inferQuotaPoolKey('acme' as any)).toBe('acme::account');
  });
});

describe('provider-quota: record + read round-trip', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
  });

  it('records an observation and surfaces it via getQuotaStateForKeys', () => {
    const rec = recordQuotaObservation({
      platform: 'groq',
      keyId: 7,
      quotaPoolKey: 'groq::account',
      metric: 'requests',
      limit: 1000,
      remaining: 950,
      source: 'header',
    });
    expect(rec).not.toBeNull();

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'groq' && s.keyId === 7 && s.metric === 'requests');
    expect(row).toBeDefined();
    expect(row!.limit).toBe(1000);
    expect(row!.remaining).toBe(950);
  });
});

describe('provider-quota: parse from response headers (shared parseRetryAfterMs)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('parses Groq ratelimit headers into a requests observation', () => {
    const resp = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '90',
        'x-ratelimit-reset-requests': '60',
      },
    });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 });
    const requests = obs.find(o => o.metric === 'requests');
    expect(requests).toBeDefined();
    expect(requests!.limit).toBe(100);
    expect(requests!.remaining).toBe(90);
  });

  it('reads Retry-After on a 429 via the shared parser (dedup of base.ts)', () => {
    const resp = new Response(null, { status: 429, headers: { 'retry-after': '30' } });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 });
    // The shared parseRetryAfterMs turns "30" seconds into 30000 ms.
    expect(obs.some(o => o.retryAfterMs === 30_000)).toBe(true);
    // A 429 always marks the pool as remaining 0.
    expect(obs.some(o => o.remaining === 0)).toBe(true);
  });
});

describe('provider-quota: reset_at replenishment on read (#453)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
  });

  const past = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it('restores remaining to the known limit once reset_at has passed, and persists it', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 0, resetAt: past() });

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'groq' && s.keyId === 1);
    expect(row!.remaining).toBe(100);      // replenished to the limit
    expect(row!.resetAt).toBeNull();        // stale reset dropped

    // Persisted so it does not recur (the exhausted 0 is gone from the table).
    const persisted = readState('groq', 1, 'groq::account', 'requests');
    expect(persisted!.remaining).toBe(100);
    expect(persisted!.resetAt).toBeNull();
  });

  it('clears remaining to unknown when the limit is unknown and reset_at passed', () => {
    insertState({ platform: 'ollama', keyId: 2, pool: 'ollama::cloud', metric: 'requests', limit: null, remaining: 0, resetAt: past() });

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'ollama' && s.keyId === 2);
    expect(row!.remaining).toBeNull();      // no known limit → clear the 0
    expect(row!.resetAt).toBeNull();

    const persisted = readState('ollama', 2, 'ollama::cloud', 'requests');
    expect(persisted!.remaining).toBeNull();
  });

  it('leaves a still-active window (reset_at in the future) untouched', () => {
    insertState({ platform: 'groq', keyId: 3, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 0, resetAt: future() });

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'groq' && s.keyId === 3);
    expect(row!.remaining).toBe(0);         // still exhausted until it resets
    expect(row!.resetAt).not.toBeNull();
  });
});
