import fs from 'fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  canMakeRequest,
  canUseTokens,
  recordRequest,
  recordTokens,
  getRateLimitStatus,
} from '../../services/ratelimit.js';

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
});
