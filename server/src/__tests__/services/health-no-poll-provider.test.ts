import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// #1599: SerpSearch revoked a free account over the empty search the health
// pass sent every 5 minutes as its key check. A provider with
// supportsKeyPolling === false gets one check per key, not one per pass.
const validateKey = vi.fn();
vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    resolveProvider: () => ({ name: 'no-poll', supportsKeyPolling: false, validateKey }),
  };
});

const { initDb, getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { checkAllKeys, probeKeyValidity, NO_POLL_ERROR_REPROBE_MS } = await import('../../services/health.js');
const { SerpSearchProvider } = await import('../../providers/serpsearch.js');
const { ExaProvider } = await import('../../providers/exa.js');
const { ParallelProvider } = await import('../../providers/parallel.js');

describe('a provider that must not be polled (#1599)', () => {
  let nextId = 9300;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    validateKey.mockReset();
    validateKey.mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  /** ageMs null = never checked. */
  function seedKey(status: string, ageMs: number | null): number {
    const id = ++nextId;
    const enc = encrypt(`no-poll-${id}`);
    const checkedAt = ageMs === null ? null : new Date(Date.now() - ageMs).toISOString().replace('T', ' ').slice(0, 19);
    getDb().prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, last_checked_at)
      VALUES (?, 'serpsearch', ?, ?, ?, ?, 1, ?, ?)
    `).run(id, `no-poll-${id}`, enc.encrypted, enc.iv, enc.authTag, status, checkedAt);
    return id;
  }

  it('validates a new key once, then never again on the schedule', async () => {
    const id = seedKey('unknown', null);

    expect((await checkAllKeys()).checkedKeyIds).toEqual([id]);
    expect(validateKey).toHaveBeenCalledOnce();

    // The next scheduled pass and the forced post-wake pass both skip it.
    expect((await checkAllKeys()).skippedKeyIds).toEqual([id]);
    expect((await checkAllKeys({ force: true })).skippedKeyIds).toEqual([id]);
    expect(validateKey).toHaveBeenCalledOnce();
  });

  it('leaves a healthy or invalid key alone however long ago it was checked', async () => {
    const healthy = seedKey('healthy', 30 * 24 * 60 * 60 * 1000);
    const invalid = seedKey('invalid', 30 * 24 * 60 * 60 * 1000);

    const pass = await checkAllKeys({ force: true });

    expect(pass.checkedKeyIds).toEqual([]);
    expect(pass.skippedKeyIds.sort()).toEqual([healthy, invalid].sort());
    expect(validateKey).not.toHaveBeenCalled();
  });

  it('re-asks about a key parked at error at most once per reprobe window', async () => {
    const recent = seedKey('error', 10 * 60 * 1000);
    const stale = seedKey('error', NO_POLL_ERROR_REPROBE_MS + 60 * 1000);

    const pass = await checkAllKeys();

    expect(pass.checkedKeyIds).toEqual([stale]);
    expect(pass.skippedKeyIds).toEqual([recent]);
  });

  it('"Check all" still validates every key', async () => {
    const id = seedKey('healthy', 60 * 1000);

    expect((await checkAllKeys({ force: true, manual: true })).checkedKeyIds).toEqual([id]);
    expect(validateKey).toHaveBeenCalledOnce();
  });

  it('the cooldown probe treats the key as inconclusive without probing', async () => {
    const id = seedKey('healthy', 60 * 1000);

    expect(await probeKeyValidity(id)).toBe('error');
    expect(validateKey).not.toHaveBeenCalled();
  });

  it('is set for the providers whose key check is an empty search', () => {
    expect(new SerpSearchProvider().supportsKeyPolling).toBe(false);
    expect(new ExaProvider().supportsKeyPolling).toBe(false);
    expect(new ParallelProvider().supportsKeyPolling).toBe(false);
  });
});
