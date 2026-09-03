import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getQuotaForecast } from '../../services/quota-forecast.js';

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
      (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, observed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(row.platform, row.keyId, row.pool, row.metric, row.limit, row.remaining, row.resetAt);
}

const future = () => new Date(Date.now() + 12 * 3600 * 1000).toISOString(); // 12h ahead → within today

describe('quota-forecast: daily balance aggregation (#1104)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
  });

  it('reports used/remaining/pct/reset for a request pool with a known limit', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 60, resetAt: future() });

    const forecast = getQuotaForecast();
    expect(forecast).toHaveLength(1);
    const e = forecast[0];
    expect(e.platform).toBe('groq');
    expect(e.pool).toBe('groq::account');
    expect(e.used).toBe(40);
    expect(e.remaining).toBe(60);
    expect(e.limit).toBe(100);
    expect(e.remaining_pct).toBe(60);
    expect(e.low_balance).toBe(false);
    expect(e.seconds_until_reset).toBeGreaterThan(0);
  });

  it('flags low_balance below the 10% threshold', () => {
    insertState({ platform: 'openai', keyId: 1, pool: 'openai::account', metric: 'requests', limit: 100, remaining: 8, resetAt: future() });

    const e = getQuotaForecast()[0];
    expect(e.remaining_pct).toBe(8);
    expect(e.low_balance).toBe(true);
  });

  it('flags low_balance on the absolute floor even when pct looks fine', () => {
    insertState({ platform: 'openrouter', keyId: 1, pool: 'openrouter::free', metric: 'requests', limit: 10000, remaining: 15, resetAt: future() });

    const e = getQuotaForecast()[0];
    expect(e.remaining_pct).toBe(0); // 15/10000 rounds to 0
    expect(e.low_balance).toBe(true);
  });

  it('dedupes multi-key shared pools to the tightest remaining', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 90, resetAt: future() });
    insertState({ platform: 'groq', keyId: 2, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 20, resetAt: future() });

    const forecast = getQuotaForecast();
    expect(forecast).toHaveLength(1);
    expect(forecast[0].remaining).toBe(20); // tightest wins
    // 20 of 100 is a fifth of the window, and 100 is below the absolute
    // floor's minimum, so nothing here is low.
    expect(forecast[0].low_balance).toBe(false);
  });

  it('does not apply the absolute floor to a small window', () => {
    // A 30/day tier with 25 left has five sixths of its window: the absolute
    // floor of 20 would call that low, which is the bug this guards.
    insertState({ platform: 'cerebras', keyId: 1, pool: 'cerebras::account', metric: 'requests', limit: 30, remaining: 25, resetAt: future() });

    const e = getQuotaForecast()[0];
    expect(e.remaining_pct).toBe(83);
    expect(e.low_balance).toBe(false);
  });

  it('still warns on a small window once the percentage rule bites', () => {
    insertState({ platform: 'cerebras', keyId: 1, pool: 'cerebras::account', metric: 'requests', limit: 30, remaining: 2, resetAt: future() });

    expect(getQuotaForecast()[0].low_balance).toBe(true);
  });

  it('leaves used null when the provider reported no remaining', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: null, resetAt: future() });

    const e = getQuotaForecast()[0];
    expect(e.used).toBeNull();
    expect(e.remaining).toBeNull();
    expect(e.remaining_pct).toBeNull();
    expect(e.low_balance).toBe(false);
  });

  it('keys the dedupe on the pool alone, which already names its platform', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 1000, remaining: 900, resetAt: future() });
    insertState({ platform: 'groq', keyId: 2, pool: 'groq::batch', metric: 'requests', limit: 1000, remaining: 800, resetAt: future() });

    const pools = getQuotaForecast().map(e => e.pool);
    expect(pools).toContain('groq::account');
    expect(pools).toContain('groq::batch');
  });

  it('ignores non-request metrics and unknown limits', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'tokens', limit: 1000, remaining: 500, resetAt: future() });
    insertState({ platform: 'ollama', keyId: 1, pool: 'ollama::account', metric: 'requests', limit: null, remaining: null, resetAt: null });

    const forecast = getQuotaForecast();
    expect(forecast).toHaveLength(0);
  });
});
