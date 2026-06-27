import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  canMakeRequest,
  canUseTokens,
  recordRequest,
  recordTokens,
  getRateLimitStatus,
  getNextCooldownDuration,
  getCooldownDurationForLimit,
  recentHitCount,
  canUseProvider,
  providerDailyRequestCount,
  getProviderDailyRequestCap,
} from '../../services/ratelimit.js';
import { parseRetryAfterMs } from '../../providers/base.js';

function removeDbFile(dbPath: string) {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // Best-effort cleanup for temp SQLite files.
    }
  }
}

describe('Rate Limiter', () => {
  // Use unique identifiers per test to avoid cross-contamination
  let testId: number;

  beforeEach(() => {
    testId = Math.floor(Math.random() * 1_000_000);
  });

  describe('canMakeRequest', () => {
    it('should allow request when under RPM limit', () => {
      expect(canMakeRequest('groq', 'llama-70b', testId, {
        rpm: 30, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });

    it('should deny request when RPM limit reached', () => {
      const limits = { rpm: 2, rpd: null, tpm: null, tpd: null };
      recordRequest('groq', 'llama-70b', testId);
      recordRequest('groq', 'llama-70b', testId);
      expect(canMakeRequest('groq', 'llama-70b', testId, limits)).toBe(false);
    });

    it('should deny request when RPD limit reached', () => {
      const limits = { rpm: null, rpd: 1, tpm: null, tpd: null };
      recordRequest('google', 'gemini', testId);
      expect(canMakeRequest('google', 'gemini', testId, limits)).toBe(false);
    });

    it('should allow request when limits are null (unlimited)', () => {
      expect(canMakeRequest('nvidia', 'nemotron', testId, {
        rpm: null, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('canUseTokens', () => {
    it('should allow tokens when under TPM limit', () => {
      expect(canUseTokens('groq', 'llama-70b', testId, 500, {
        tpm: 6000, tpd: null,
      })).toBe(true);
    });

    it('should deny tokens when TPM limit would be exceeded', () => {
      recordTokens('cerebras', 'qwen3', testId, 50000);
      expect(canUseTokens('cerebras', 'qwen3', testId, 20000, {
        tpm: 60000, tpd: null,
      })).toBe(false);
    });

    it('should allow when limit is null', () => {
      expect(canUseTokens('nvidia', 'nemotron', testId, 100000, {
        tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('getRateLimitStatus', () => {
    it('should return current usage counts', () => {
      const limits = { rpm: 30, rpd: 1000, tpm: 6000, tpd: null };
      recordRequest('groq', 'test-model', testId);
      recordRequest('groq', 'test-model', testId);
      recordTokens('groq', 'test-model', testId, 500);

      const status = getRateLimitStatus('groq', 'test-model', testId, limits);
      expect(status.rpm.used).toBe(2);
      expect(status.rpm.limit).toBe(30);
      expect(status.rpd.used).toBe(2);
      expect(status.tpm.used).toBe(500);
    });
  });

  describe('escalating cooldown', () => {
    it('escalates the 2nd/3rd/4th hit within 24h to 10m / 1h / 24h', () => {
      const id = Math.floor(Math.random() * 1_000_000);
      const args = ['cerebras', `escalating-model-${id}`, id] as const;
      // 1st: 2 minutes
      expect(getNextCooldownDuration(...args)).toBe(2 * 60 * 1000);
      // 2nd: 10 minutes
      expect(getNextCooldownDuration(...args)).toBe(10 * 60 * 1000);
      // 3rd: 1 hour
      expect(getNextCooldownDuration(...args)).toBe(60 * 60 * 1000);
      // 4th: 24 hours
      expect(getNextCooldownDuration(...args)).toBe(24 * 60 * 60 * 1000);
      // 5th+ stays at 24h (quarantined until next quota window)
      expect(getNextCooldownDuration(...args)).toBe(24 * 60 * 60 * 1000);
    });

    it('counts independently per (platform, model, key)', () => {
      const id = Math.floor(Math.random() * 1_000_000);
      // Different keys for the same model should each start at 2m, not share state.
      expect(getNextCooldownDuration('groq', `m-${id}`, id)).toBe(2 * 60 * 1000);
      expect(getNextCooldownDuration('groq', `m-${id}`, id + 1)).toBe(2 * 60 * 1000);
      expect(getNextCooldownDuration('groq', `m-${id}-other`, id)).toBe(2 * 60 * 1000);
    });
  });

  describe('getCooldownDurationForLimit (daily vs transient 429)', () => {
    it('uses a short, non-escalating cooldown when the daily quota is NOT exhausted', () => {
      const id = Math.floor(Math.random() * 1_000_000);
      const args = ['groq', `transient-${id}`, id] as const;
      // groq-like: large daily quota, no requests recorded yet → transient (TPM/RPM)
      // 429s must stay at the short fixed cooldown and never escalate.
      expect(getCooldownDurationForLimit(...args, { rpd: 1000, tpd: null })).toBe(90 * 1000);
      expect(getCooldownDurationForLimit(...args, { rpd: 1000, tpd: null })).toBe(90 * 1000);
      expect(getCooldownDurationForLimit(...args, { rpd: 1000, tpd: null })).toBe(90 * 1000);
    });

    it('stays transient for the first 429 with null daily limits (heuristic threshold)', () => {
      const id = Math.floor(Math.random() * 1_000_000);
      // 1st 429 → transient (no signal yet). Subsequent 429s stay transient
      // until the threshold is crossed.
      expect(
        getCooldownDurationForLimit('mistral', `nolimit-${id}`, id, { rpd: null, tpd: null }),
      ).toBe(90 * 1000);
    });

    it('escalates null-limit 429s through the same ladder as documented RPD exhaustion', () => {
      // Documented RPD path (see "escalates only once the daily request limit
      // is actually reached"): 1st call after counter ≥ limit → 2min (idx=0),
      // 2nd → 10min (idx=1), 3rd → HOUR (idx=2), 4th+ → DAY (idx=3).
      //
      // Null-limit path mirrors that sequence starting at the 2nd 429 (1st
      // is transient — no signal yet). Uses an independent counter so the
      // ladder index isn't inflated by the heuristic's own hits.
      const id = Math.floor(Math.random() * 1_000_000);
      const platform = 'ollama';
      const model = `nolimit-esc-${id}`;
      // 1st 429 — no history → transient
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(90 * 1000);
      // 2nd 429 — heuristic threshold (2) crossed → 2min (ladder idx=0)
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(2 * 60 * 1000);
      // 3rd 429 → 10min (idx=1)
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(10 * 60 * 1000);
      // 4th 429 → HOUR (idx=2)
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(60 * 60 * 1000);
      // 5th 429 → DAY (idx=3, capped)
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(24 * 60 * 60 * 1000);
      // 6th+ stays at DAY
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(24 * 60 * 60 * 1000);
    });

    it('does NOT trigger the heuristic when limits are known (even after 5+ hits)', () => {
      // rpd=1000 known: counters track it, daily-exhausted check uses the
      // counter, not the hit count. The null-limits heuristic only fires
      // when BOTH rpd AND tpd are null. With a known cap, repeated 429s
      // stay transient (the counter-based path takes over instead).
      const id = Math.floor(Math.random() * 1_000_000);
      const platform = 'openrouter';
      const model = `known-${id}`;
      for (let i = 0; i < 5; i++) {
        expect(getCooldownDurationForLimit(platform, model, id, { rpd: 1000, tpd: null })).toBe(90 * 1000);
      }
      expect(recentHitCount(platform, model, id, Date.now())).toBe(0);
    });

    it('clears null-limit hit history after a successful request', () => {
      const id = Math.floor(Math.random() * 1_000_000);
      const platform = 'ollama';
      const model = `nolimit-success-${id}`;

      expect(getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(90 * 1000);
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(2 * 60 * 1000);
      expect(recentHitCount(platform, model, id, Date.now())).toBe(2);

      recordRequest(platform, model, id);

      expect(recentHitCount(platform, model, id, Date.now())).toBe(0);
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(90 * 1000);
    });

    it('escalates only once the daily request limit is actually reached', () => {
      const id = Math.floor(Math.random() * 1_000_000);
      const platform = 'openrouter';
      const model = `daily-${id}`;
      // Below the daily limit → still transient.
      recordRequest(platform, model, id);
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: 5, tpd: null })).toBe(90 * 1000);
      // Reach the daily limit → now it escalates (2m, then 10m, ...).
      for (let i = 0; i < 5; i++) recordRequest(platform, model, id);
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: 5, tpd: null })).toBe(2 * 60 * 1000);
      expect(getCooldownDurationForLimit(platform, model, id, { rpd: 5, tpd: null })).toBe(10 * 60 * 1000);
    });
  });

  describe('persistent state', () => {
    it('preserves per-key usage and cooldowns after the limiter module reloads', async () => {
      process.env.ENCRYPTION_KEY = '0'.repeat(64);
      const dbPath = `/tmp/freeapi-ratelimit-${Date.now()}-${Math.random()}.db`;
      const keyId = 4242;
      let db: { close: () => void } | undefined;

      try {
        vi.resetModules();
        const dbModule = await import('../../db/index.js');
        db = dbModule.initDb(dbPath);
        const limiter = await import('../../services/ratelimit.js');

        limiter.recordRequest('groq', 'persistent-model', keyId);
        limiter.recordTokens('groq', 'persistent-model', keyId, 950);
        limiter.setCooldown('groq', 'persistent-model', keyId, 60_000);
        db.close();
        db = undefined;

        vi.resetModules();
        const dbModuleAfterReload = await import('../../db/index.js');
        db = dbModuleAfterReload.initDb(dbPath);
        const limiterAfterReload = await import('../../services/ratelimit.js');

        expect(limiterAfterReload.canMakeRequest('groq', 'persistent-model', keyId, {
          rpm: null, rpd: 1, tpm: null, tpd: null,
        })).toBe(false);
        expect(limiterAfterReload.canUseTokens('groq', 'persistent-model', keyId, 100, {
          tpm: null, tpd: 1000,
        })).toBe(false);
        expect(limiterAfterReload.isOnCooldown('groq', 'persistent-model', keyId)).toBe(true);
      } finally {
        db?.close();
        removeDbFile(dbPath);
      }
    });
  });

  describe('provider-wide daily request cap (#162)', () => {
    const ENV = 'PROVIDER_DAILY_REQUEST_CAP_OPENROUTER';
    let original: string | undefined;

    beforeEach(() => { original = process.env[ENV]; });
    afterEach(() => {
      if (original === undefined) delete process.env[ENV];
      else process.env[ENV] = original;
    });

    it('defaults to OpenRouter ~1000/day and allows env override / disable', () => {
      delete process.env[ENV];
      expect(getProviderDailyRequestCap('openrouter')).toBe(1000);
      expect(getProviderDailyRequestCap('groq')).toBeNull(); // no shared cap
      process.env[ENV] = '50';
      expect(getProviderDailyRequestCap('openrouter')).toBe(50);
      process.env[ENV] = '0'; // 0 disables the cap
      expect(getProviderDailyRequestCap('openrouter')).toBeNull();
    });

    it('counts requests across ALL of a provider\'s models for one key', () => {
      recordRequest('openrouter', 'deepseek/deepseek-v3.1:free', testId);
      recordRequest('openrouter', 'deepseek/deepseek-v3.1:free', testId);
      recordRequest('openrouter', 'qwen/qwen3-coder:free', testId);
      // Same key on a different provider must not bleed into the count.
      recordRequest('groq', 'llama-70b', testId);
      expect(providerDailyRequestCount('openrouter', testId)).toBe(3);
    });

    it('blocks the whole provider once the shared daily cap is hit', () => {
      process.env[ENV] = '3';
      recordRequest('openrouter', 'model-a', testId);
      recordRequest('openrouter', 'model-b', testId);
      expect(canUseProvider('openrouter', testId)).toBe(true); // 2 < 3
      recordRequest('openrouter', 'model-c', testId);
      expect(canUseProvider('openrouter', testId)).toBe(false); // 3 >= 3
    });
  });
});

describe('Cooldown duration with upstream Retry-After', () => {
  const noLimits = { rpd: null, tpd: null };
  let testId: number;
  beforeEach(() => { testId = Math.floor(Math.random() * 1_000_000); });

  it('uses the transient cooldown when no Retry-After is given', () => {
    expect(getCooldownDurationForLimit('groq', 'm', testId, noLimits)).toBe(90_000);
  });

  it('never benches shorter than the heuristic (ignores a shorter Retry-After)', () => {
    expect(getCooldownDurationForLimit('groq', 'm', testId, noLimits, 30_000)).toBe(90_000);
  });

  it('honors a Retry-After longer than the heuristic', () => {
    expect(getCooldownDurationForLimit('groq', 'm', testId, noLimits, 300_000)).toBe(300_000);
  });

  it('caps an absurd Retry-After at a day', () => {
    expect(getCooldownDurationForLimit('groq', 'm', testId, noLimits, 5 * 86_400_000)).toBe(86_400_000);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('parses an HTTP-date into a positive future delay', () => {
    const ms = parseRetryAfterMs(new Date(Date.now() + 60_000).toUTCString());
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});
