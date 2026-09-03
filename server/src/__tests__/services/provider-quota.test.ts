import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  recordQuotaObservation,
  getQuotaStateForKeys,
  parseQuotaObservationsFromResponse,
  inferQuotaPoolKey,
} from '../../services/provider-quota.js';
import { pruneQuotaObservations } from '../../services/request-retention.js';

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
    // AnyAPI's 100K tokens/day is one account-wide budget, so every model on
    // the platform shares a single pool.
    expect(inferQuotaPoolKey('anyapi')).toBe('anyapi::free');
    expect(inferQuotaPoolKey('anyapi', 'qwen/qwen3-coder:free')).toBe('anyapi::free');
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

  it('surfaces the newest observation per pool when the log holds many', () => {
    // Older rows for the same pool must never win, and rows for a sibling pool
    // must never bleed across. Mirrors the dashboard poll on a long-lived
    // install whose log holds hundreds of thousands of rows per pool.
    for (let i = 0; i < 25; i++) {
      recordQuotaObservation({
        platform: 'groq', keyId: 7, quotaPoolKey: 'groq::account', metric: 'tokens',
        limit: 1000, remaining: 1000 - i, modelId: `old-${i}`, source: 'header',
        observedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      });
    }
    recordQuotaObservation({
      platform: 'groq', keyId: 7, quotaPoolKey: 'groq::account', metric: 'tokens',
      limit: 1000, remaining: 5, modelId: 'newest', source: 'header',
      observedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
    });
    recordQuotaObservation({
      platform: 'groq', keyId: 7, quotaPoolKey: 'groq::account', metric: 'requests',
      limit: 30, remaining: 1, modelId: 'other-metric', source: 'header',
      observedAt: new Date(Date.UTC(2026, 0, 3)).toISOString(),
    });
    const rows = getQuotaStateForKeys().filter(r => r.platform === 'groq' && r.keyId === 7);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.metric === 'tokens')?.modelId).toBe('newest');
    expect(rows.find(r => r.metric === 'tokens')?.remaining).toBe(5);
    expect(rows.find(r => r.metric === 'requests')?.modelId).toBe('other-metric');
  });

  it('prunes the observation log by age and count without touching state', () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO provider_quota_observations
        (id, platform, key_id, quota_pool_key, metric, observed_at, created_at)
      VALUES (?, 'groq', 7, 'groq::account', 'tokens', ?, ?)
    `);
    const now = Date.UTC(2026, 8, 1);
    const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    for (let i = 0; i < 10; i++) {
      // 5 rows older than 30 days, 5 fresh ones.
      const at = stamp(now - (i < 5 ? 40 : 1) * 86_400_000 - i * 1000);
      insert.run(`obs-${i}`, at, at);
    }
    insertState({ platform: 'groq', keyId: 7, pool: 'groq::account', metric: 'tokens', limit: 1000, remaining: 10, resetAt: null });

    expect(pruneQuotaObservations(db, now)).toEqual({ deleted: 5, done: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM provider_quota_observations').get()).toEqual({ n: 5 });

    process.env.QUOTA_OBSERVATIONS_MAX_ROWS = '2';
    try {
      expect(pruneQuotaObservations(db, now)).toEqual({ deleted: 3, done: true });
    } finally {
      delete process.env.QUOTA_OBSERVATIONS_MAX_ROWS;
    }
    const left = db.prepare('SELECT id FROM provider_quota_observations ORDER BY created_at DESC').all() as { id: string }[];
    expect(left.map(r => r.id)).toEqual(['obs-5', 'obs-6']);
    expect(readState('groq', 7, 'groq::account', 'tokens')?.remaining).toBe(10);
  });

  it('stops a large sweep at its time budget and reports it unfinished', () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO provider_quota_observations
        (id, platform, key_id, quota_pool_key, metric, observed_at, created_at)
      VALUES (?, 'groq', 7, 'groq::account', 'tokens', ?, ?)
    `);
    const now = Date.UTC(2026, 8, 1);
    const old = new Date(now - 60 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    const tx = db.transaction(() => { for (let i = 0; i < 45_000; i++) insert.run(`o-${i}`, old, old); });
    tx();
    // A zero budget allows exactly one chunk before the check trips.
    const first = pruneQuotaObservations(db, now, 0);
    expect(first.done).toBe(false);
    expect(first.deleted).toBe(5_000);
    const rest = pruneQuotaObservations(db, now, 60_000);
    expect(rest).toEqual({ deleted: 40_000, done: true });
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

  // #705: the panel rendered a bare "key #7", which names nothing an operator
  // recognises once a provider holds several keys.
  it('carries the label of the key the state belongs to', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (41, 'groq', 'Work account', 'x', 'y', 'z', 'unknown', 1)
    `).run();
    recordQuotaObservation({
      platform: 'groq', keyId: 41, quotaPoolKey: 'groq::account',
      metric: 'requests', limit: 10, remaining: 1, source: 'header',
    });

    const row = getQuotaStateForKeys().find(s => s.keyId === 41);
    expect(row!.keyLabel).toBe('Work account');
  });

  it('leaves the label null when the key row is gone', () => {
    recordQuotaObservation({
      platform: 'groq', keyId: 4242, quotaPoolKey: 'groq::account',
      metric: 'requests', limit: 10, remaining: 1, source: 'header',
    });

    const row = getQuotaStateForKeys().find(s => s.keyId === 4242);
    expect(row).toBeDefined();
    expect(row!.keyLabel).toBeNull();
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
