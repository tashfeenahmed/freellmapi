import { describe, it, expect, beforeEach } from 'vitest';
import {
  canMakeRequest,
  canUseTokens,
  recordRequest,
  recordTokens,
  getRateLimitStatus,
  setCooldown,
  isOnCooldown,
  loadRateLimitState,
  flushRateLimitState,
  _resetForTests,
} from '../../services/ratelimit.js';
import { initDb } from '../../db/index.js';

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

  describe('SQLite persistence', () => {
    // Simulates a server restart: record some traffic + a cooldown, flush
    // to SQLite, wipe the in-memory state (the "restart"), reload, and
    // confirm the router still sees the prior counters and cooldown.
    it('survives a process restart by round-tripping through SQLite', () => {
      const db = initDb(':memory:');
      const platform = `persist-${Math.random().toString(36).slice(2, 8)}`;
      const modelId = 'test-model';
      const keyId = testId;
      const limits = { rpm: 5, rpd: 100, tpm: 6000, tpd: null };

      // Pre-restart traffic: 3 requests + 500 tokens + a cooldown.
      recordRequest(platform, modelId, keyId);
      recordRequest(platform, modelId, keyId);
      recordRequest(platform, modelId, keyId);
      recordTokens(platform, modelId, keyId, 500);
      setCooldown(platform, modelId, keyId, 30_000);

      flushRateLimitState(db);

      // Simulate the restart — wipe RAM, then reload from SQLite.
      _resetForTests();
      expect(canMakeRequest(platform, modelId, keyId, limits)).toBe(true);
      expect(isOnCooldown(platform, modelId, keyId)).toBe(false);

      loadRateLimitState(db);

      const status = getRateLimitStatus(platform, modelId, keyId, limits);
      expect(status.rpm.used).toBe(3);
      expect(status.rpd.used).toBe(3);
      expect(status.tpm.used).toBe(500);
      expect(isOnCooldown(platform, modelId, keyId)).toBe(true);
    });

    it('drops cooldowns whose expiry has already passed', () => {
      const db = initDb(':memory:');
      const platform = `persist-${Math.random().toString(36).slice(2, 8)}`;
      const modelId = 'test-model';
      const keyId = testId;

      // 1ms cooldown, then wait it out before flushing.
      setCooldown(platform, modelId, keyId, 1);
      // Tiny synchronous sleep — busy-wait to avoid timer flake.
      const target = Date.now() + 5;
      while (Date.now() < target) { /* spin */ }

      flushRateLimitState(db);
      _resetForTests();
      loadRateLimitState(db);

      expect(isOnCooldown(platform, modelId, keyId)).toBe(false);
    });

    it('prunes stale entries (older than 24h) on flush', () => {
      const db = initDb(':memory:');
      const platform = `persist-${Math.random().toString(36).slice(2, 8)}`;

      // Manually inject an ancient row to simulate a long-ago flush.
      db.prepare(`
        INSERT INTO rate_limit_state (key, data, updated_at) VALUES (?, ?, ?)
      `).run(`${platform}:ghost:0:rpd`, '{"timestamps":[1]}', Date.now() - 48 * 60 * 60 * 1000);

      flushRateLimitState(db);

      const remaining = db.prepare(
        'SELECT COUNT(*) as c FROM rate_limit_state WHERE key = ?'
      ).get(`${platform}:ghost:0:rpd`) as { c: number };
      expect(remaining.c).toBe(0);
    });
  });
});
