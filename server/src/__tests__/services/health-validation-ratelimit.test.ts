import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const validateKey = vi.hoisted(() => vi.fn());

vi.mock('../../providers/index.js', () => ({
  resolveProvider: () => ({
    name: 'LLMTR',
    validateKey,
  }),
}));

const { initDb, getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const {
  checkAllKeys,
  checkKeyHealth,
  recordValidationRateLimited,
  clearValidationRateLimitState,
} = await import('../../services/health.js');

// #1369: every validation of an LLMTR key is a POST to /chat/completions with
// a nonexistent model — exactly shaped like the bot traffic their abuse
// system hunts. The scheduled pass re-asked a 429ed key every ~5 minutes
// forever, so validation traffic itself became the ban engine. A key whose
// last validation was rate-limited must be skipped until the skip window
// passes; explicit forced passes still probe.

let nextId = 30000;

function seedKey(platform: string): number {
  const id = ++nextId;
  const enc = encrypt(`ratelimit-${id}`);
  getDb().prepare(`
    INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'healthy', null)
  `).run(id, platform, `ratelimit-${id}`, enc.encrypted, enc.iv, enc.authTag);
  return id;
}

function fakeClock() {
  const state = { t: 1_000_000 };
  return {
    now: () => state.t,
    sleep: async (ms: number) => { state.t += ms; },
  };
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  getDb().prepare('DELETE FROM api_keys').run();
  clearValidationRateLimitState();
  validateKey.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('validation rate-limit backoff (#1369)', () => {
  it('skips a key rate-limited within the window, checks the rest', async () => {
    const limited = seedKey('llmtr');
    const other = seedKey('groq');
    const clock = fakeClock();
    recordValidationRateLimited(limited, clock.now());

    const checked: number[] = [];
    const result = await checkAllKeys({
      now: clock.now,
      sleep: clock.sleep,
      concurrency: 1,
      check: async (keyId: number) => { checked.push(keyId); },
    });

    expect(checked).toEqual([other]);
    expect(result.skippedKeyIds).toContain(limited);
  });

  it('re-asks after the window passes, and always on a forced pass', async () => {
    const limited = seedKey('llmtr');
    const clock = fakeClock();
    recordValidationRateLimited(limited, clock.now());

    const hourMs = 60 * 60 * 1000;
    const checked: number[] = [];
    const check = async (keyId: number) => { checked.push(keyId); };

    // Still inside the window: skipped.
    await checkAllKeys({ now: clock.now, sleep: clock.sleep, concurrency: 1, check });
    expect(checked).toEqual([]);

    // Past the window: due again.
    await clock.sleep(hourMs + 1);
    await checkAllKeys({ now: clock.now, sleep: clock.sleep, concurrency: 1, check });
    expect(checked).toEqual([limited]);

    // Forced passes ignore the backoff: explicit operator intent.
    checked.length = 0;
    recordValidationRateLimited(limited, clock.now());
    await checkAllKeys({ now: clock.now, sleep: clock.sleep, concurrency: 1, check, force: true });
    expect(checked).toEqual([limited]);
  });

  it('remembers a 429 from validation and skips the key on the next pass', async () => {
    const id = seedKey('llmtr');
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    validateKey.mockRejectedValue(err);

    await checkKeyHealth(id);
    // checkKeyHealth stamps last_checked_at: backdate it so the recency skip
    // cannot mask the 429 skip under test.
    getDb().prepare("UPDATE api_keys SET last_checked_at = '2000-01-01' WHERE id = ?").run(id);

    // Real clocks on both sides: the 429 mark is recorded with Date.now, so
    // the pass must read it with the same domain. (A fake clock here would
    // skip for the wrong reason — negative time arithmetic, not the window.)
    const checked: number[] = [];
    const result = await checkAllKeys({
      concurrency: 1,
      check: async (keyId: number) => { checked.push(keyId); },
    });
    expect(checked).toEqual([]);
    expect(result.skippedKeyIds).toContain(id);
  });

  it('does not back off on non-429 transport errors', async () => {
    const id = seedKey('llmtr');
    validateKey.mockRejectedValue(new Error('Bearer [REDACTED] failed'));

    await checkKeyHealth(id);
    getDb().prepare("UPDATE api_keys SET last_checked_at = '2000-01-01' WHERE id = ?").run(id);

    const checked: number[] = [];
    await checkAllKeys({
      concurrency: 1,
      check: async (keyId: number) => { checked.push(keyId); },
    });
    expect(checked).toEqual([id]);
  });
});
