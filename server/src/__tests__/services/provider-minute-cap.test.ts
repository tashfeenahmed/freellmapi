import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  canUseProviderMinute,
  providerMinuteRequestCount,
  getProviderMinuteRequestCap,
} from '../../services/ratelimit.js';

/**
 * Account-wide per-minute caps. The per-model rpm_limit cannot express these:
 * NVIDIA NIM meters ~40 req/min across the whole account, so every model on it
 * draws from one bucket, and a model row with rpm_limit NULL isn't pre-throttled
 * at all. Without this gate the router keeps dispatching and eats real 429s.
 */
function seedRequests(platform: string, modelId: string, keyId: number, count: number, atMs: number) {
  const ins = getDb().prepare(`
    INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
    VALUES (?, ?, ?, 'request', 0, ?)
  `);
  for (let i = 0; i < count; i++) ins.run(platform, modelId, keyId, atMs);
}

describe('provider-wide per-minute request cap', () => {
  let keyId: number;

  beforeEach(() => {
    initDb(':memory:');
    keyId = Math.floor(Math.random() * 1_000_000);
  });

  afterEach(() => {
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA;
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_GROQ;
  });

  it('ships a default cap for nvidia and none for a provider without one', () => {
    expect(getProviderMinuteRequestCap('nvidia')).toBe(40);
    expect(getProviderMinuteRequestCap('groq')).toBeNull();
  });

  it('honours an env override and treats 0 as disabled', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '5';
    expect(getProviderMinuteRequestCap('nvidia')).toBe(5);
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '0';
    expect(getProviderMinuteRequestCap('nvidia')).toBeNull();
  });

  it('uses a per-account override ahead of provider defaults and env settings', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '5';
    const row = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, provider_rpm_limit)
      VALUES ('nvidia', 'account', 'x', 'x', 'x', 'healthy', 1, 12)
    `).run();
    const id = Number(row.lastInsertRowid);
    expect(getProviderMinuteRequestCap('nvidia', id)).toBe(12);
    getDb().prepare('UPDATE api_keys SET provider_rpm_limit = 0 WHERE id = ?').run(id);
    expect(getProviderMinuteRequestCap('nvidia', id)).toBeNull();
  });

  it('sums usage across every model on the same account+key', () => {
    const now = Date.now();
    // The whole point: three different models, one shared budget.
    seedRequests('nvidia', 'glm-4.7', keyId, 10, now - 5_000);
    seedRequests('nvidia', 'minimax-m3', keyId, 10, now - 4_000);
    seedRequests('nvidia', 'deepseek-v4', keyId, 10, now - 3_000);

    expect(providerMinuteRequestCount('nvidia', keyId, now)).toBe(30);
  });

  it('blocks once the shared budget is spent, even for an untouched model', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '40';
    const now = Date.now();
    seedRequests('nvidia', 'glm-4.7', keyId, 40, now - 10_000);

    // deepseek-v4 has made zero requests of its own and may well have a NULL
    // rpm_limit, but the account budget is gone.
    expect(canUseProviderMinute('nvidia', keyId, now)).toBe(false);
  });

  it('allows again once the minute window rolls past', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '40';
    const now = Date.now();
    seedRequests('nvidia', 'glm-4.7', keyId, 40, now - 61_000);

    expect(providerMinuteRequestCount('nvidia', keyId, now)).toBe(0);
    expect(canUseProviderMinute('nvidia', keyId, now)).toBe(true);
  });

  it('does not gate a provider with no configured cap', () => {
    const now = Date.now();
    seedRequests('groq', 'llama-3.3-70b', keyId, 500, now - 1_000);
    expect(canUseProviderMinute('groq', keyId, now)).toBe(true);
  });

  it('keeps separate budgets per key on the same platform', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '40';
    const now = Date.now();
    const other = keyId + 1;
    seedRequests('nvidia', 'glm-4.7', keyId, 40, now - 5_000);

    expect(canUseProviderMinute('nvidia', keyId, now)).toBe(false);
    expect(canUseProviderMinute('nvidia', other, now)).toBe(true);
  });
});
