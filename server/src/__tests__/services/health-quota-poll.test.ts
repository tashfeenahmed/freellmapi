import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { encrypt } from '../../lib/crypto.js';
import { getDb, initDb } from '../../db/index.js';

// #1403: the health pass piggybacks provider-reported quota polling on a
// healthy verdict, throttled per key, and a quota failure must never bend the
// health verdict itself.
const fetchQuota = vi.hoisted(() => vi.fn());
const validateKey = vi.hoisted(() => vi.fn());

vi.mock('../../providers/index.js', () => ({
  resolveProvider: () => ({
    name: 'OpenRouter',
    validateKey,
    // Stands in for the OpenAICompatProvider override (hasQuotaProbe true, so
    // supportsQuotaPolling passes it).
    hasQuotaProbe: true,
    fetchQuota,
  }),
}));

const { checkKeyHealth, maybePollKeyQuota, QUOTA_POLL_INTERVAL_MS } = await import('../../services/health.js');

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

let nextId = 9100;
function seedKey(): number {
  const id = ++nextId;
  const key = encrypt('sk-or-health-test');
  getDb().prepare(`
    INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status)
    VALUES (?, 'openrouter', 'quota-poll-test', ?, ?, ?, 1, 'unknown')
  `).run(id, key.encrypted, key.iv, key.authTag);
  return id;
}

function seedQuotaApiObservation(keyId: number, ageMs: number): void {
  const seen = new Date(Date.now() - ageMs).toISOString().replace('T', ' ').replace('Z', '');
  getDb().prepare(`
    INSERT INTO provider_quota_observations
      (id, platform, key_id, quota_pool_key, metric, source, created_at, observed_at)
    VALUES (?, 'openrouter', ?, 'openrouter::account', 'credits', 'quota_api', ?, ?)
  `).run(`qpo-${keyId}-${ageMs}`, keyId, seen, seen);
}

beforeEach(() => {
  fetchQuota.mockReset();
  validateKey.mockReset();
  vi.useRealTimers();
});

describe('health-pass quota polling (#1403)', () => {
  it('polls quota after a healthy check and records nothing on failure without changing the verdict', async () => {
    const keyId = seedKey();
    validateKey.mockResolvedValue(true);
    fetchQuota.mockResolvedValue(false); // quota endpoint down

    const status = await checkKeyHealth(keyId);
    expect(status).toBe('healthy');
    // Give the fire-and-forget poll a tick to run.
    await new Promise(r => setImmediate(r));
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    const row = getDb().prepare('SELECT status FROM api_keys WHERE id = ?').get(keyId) as { status: string };
    expect(row.status).toBe('healthy');
  });

  it('fetchQuota throwing does not demote the key', async () => {
    const keyId = seedKey();
    validateKey.mockResolvedValue(true);
    fetchQuota.mockRejectedValue(new Error('socket hang up'));
    const status = await checkKeyHealth(keyId);
    expect(status).toBe('healthy');
    await new Promise(r => setImmediate(r));
    const row = getDb().prepare('SELECT status FROM api_keys WHERE id = ?').get(keyId) as { status: string };
    expect(row.status).toBe('healthy');
  });

  it('does not poll after an invalid verdict', async () => {
    const keyId = seedKey();
    validateKey.mockResolvedValue({ valid: false, error: 'bad key' });
    const status = await checkKeyHealth(keyId);
    expect(status).toBe('invalid');
    await new Promise(r => setImmediate(r));
    expect(fetchQuota).not.toHaveBeenCalled();
  });

  it('maybePollKeyQuota throttles to one poll per interval per key', async () => {
    const keyId = seedKey();
    fetchQuota.mockResolvedValue(true);

    // Fresh observation: too soon, must skip.
    seedQuotaApiObservation(keyId, 60_000);
    expect(await maybePollKeyQuota(keyId)).toBe(false);
    expect(fetchQuota).not.toHaveBeenCalled();

    // Only an old observation remains: poll runs.
    getDb().prepare("DELETE FROM provider_quota_observations WHERE key_id = ? AND created_at > datetime('now', '-1 hour')").run(keyId);
    seedQuotaApiObservation(keyId, QUOTA_POLL_INTERVAL_MS + 60_000);
    expect(await maybePollKeyQuota(keyId)).toBe(true);
    expect(fetchQuota).toHaveBeenCalledTimes(1);
  });

  it('maybePollKeyQuota polls immediately when the key has no quota_api history', async () => {
    const keyId = seedKey();
    fetchQuota.mockResolvedValue(true);
    expect(await maybePollKeyQuota(keyId)).toBe(true);
    expect(fetchQuota).toHaveBeenCalledTimes(1);
  });
});
