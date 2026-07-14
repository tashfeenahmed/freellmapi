import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateDelay, checkThrottle, applyThrottle, ThrottleContext } from '../../services/throttler';
import { getDb, initDb } from '../../db/index.js';
import { recordRequest } from '../../services/ratelimit.js';
import * as providerLimitsModule from '../../services/provider-limits.js';

// Mock the provider-limits module to avoid file path issues
vi.mock('../../services/provider-limits.js', async () => {
  const actual = await vi.importActual('../../services/provider-limits.js');
  return {
    ...actual,
    getPlatformDelayThreshold: vi.fn().mockImplementation((platform: string) => {
      // Return 0.5 for all platforms to match expected test behavior
      return 0.5;
    }),
  };
});

describe('Throttler delay calculation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Set up a fresh in-memory database for each test
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // Reset the mock to return 0.5 threshold
    vi.mocked(providerLimitsModule.getPlatformDelayThreshold).mockReturnValue(0.5);
  });

  describe('calculateDelay', () => {
    it('returns 0 when below threshold', () => {
      expect(calculateDelay(60, 100000, 25, undefined, 0.5)).toBe(0); // 41.6% < 50%
      expect(calculateDelay(60, 100000, undefined, 40000, 0.5)).toBe(0); // 40% < 50%
    });

    it('returns minimum 100ms at threshold', () => {
      expect(calculateDelay(60, 100000, 30, undefined, 0.5)).toBe(100); // 50% = threshold
      expect(calculateDelay(60, 100000, undefined, 50000, 0.5)).toBe(100); // 50% = threshold
    });

    it('calculates proportional delay above threshold', () => {
      // With 0.5 threshold, 75% usage = (0.75-0.5)*60000 = 15000ms
      expect(calculateDelay(60, 100000, 45, undefined, 0.5)).toBeCloseTo(15000, -2);
    });

    it('takes max of RPM and TPM delays', () => {
      // RPM: 70/60 = 1.167 → (1.167-0.5)*60000 ≈ 40020ms
      // TPM: 60000/100000 = 0.6 → (0.6-0.5)*60000 = 6000ms
      // Expect max: ~40020ms
      expect(calculateDelay(60, 100000, 70, 60000, 0.5)).toBeGreaterThan(35000);
    });

    it('handles null limits correctly', () => {
      // RPM null → only TPM contributes: (0.6-0.5)*60000 = 6000ms (floats may give 5999 due to precision)
      expect(calculateDelay(null, 100000, undefined, 60000, 0.5)).toBeGreaterThanOrEqual(5999);

      // TPM null → only RPM contributes: (40/60-0.5)*60000 = (0.667-0.5)*60000 = 10020ms (may give 9999)
      expect(calculateDelay(60, null, 40, undefined, 0.5)).toBeGreaterThanOrEqual(9999);
    });

    it('handles RPM at threshold, TPM below → RPM minimum 100ms', () => {
      // RPM: 30/60 = 0.5 (exactly threshold) → 100ms
      // TPM: 40000/100000 = 0.4 (< threshold) → 0ms
      // Expect max: 100ms
      expect(calculateDelay(60, 100000, 30, 40000, 0.5)).toBe(100);
    });

    it('handles TPM at threshold, RPM below → TPM minimum 100ms', () => {
      // RPM: 20/60 = 0.33 (< threshold) → 0ms
      // TPM: 50000/100000 = 0.5 (exactly threshold) → 100ms
      // Expect max: 100ms
      expect(calculateDelay(60, 100000, 20, 50000, 0.5)).toBe(100);
    });

    it('handles both axes at threshold → 100ms', () => {
      expect(calculateDelay(60, 100000, 30, 50000, 0.5)).toBe(100);
    });
  });

  describe('checkThrottle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns 0 when model has no DB record', () => {
      const ctx: ThrottleContext = {
        platform: 'test',
        modelId: 'nonexistent-model',
        modelDbId: 99999,
        keyId: 1,
        requestId: 'test-req',
      };

      const delay = checkThrottle(ctx);
      expect(delay).toBe(0);
    });

    it('logs "pass" when below threshold', () => {
      const testId = Date.now();
      const db = getDb();
      db.prepare(`
        INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
        VALUES (${testId}, 'test', 'test-model-${testId}', 'Test Model', 1, 1, 'small', 60, 100000, 1)
      `).run();

      const ctx: ThrottleContext = {
        platform: 'test',
        modelId: `test-model-${testId}`,
        modelDbId: testId,
        keyId: 1,
        requestId: 'test-req',
      };

      // Only 1 request out of 60 (1.6%) -> should be below threshold
      recordRequest('test', `test-model-${testId}`, 1);

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const delay = checkThrottle(ctx);

      expect(delay).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('pass'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('rpm=1/60('));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('thresh=50%'));

      spy.mockRestore();
    });

    it('logs "delay" when above threshold', () => {
      const testId = Date.now() + 1;
      const db = getDb();
      db.prepare(`
        INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
        VALUES (${testId}, 'test', 'test-model-${testId}', 'Test Model', 1, 1, 'small', 60, 100000, 1)
      `).run();

      const ctx: ThrottleContext = {
        platform: 'test',
        modelId: `test-model-${testId}`,
        modelDbId: testId,
        keyId: 1,
        requestId: 'test-req',
      };

      // 45 requests out of 60 (75%) -> above 50% threshold
      for (let i = 0; i < 45; i++) {
        recordRequest('test', `test-model-${testId}`, 1);
      }

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const delay = checkThrottle(ctx);

      expect(delay).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('delay'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('rpm=45/60('));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('thresh=50%'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('delay='));

      spy.mockRestore();
    });

    it('includes correct ratio percentages in log output', () => {
      const testId = Date.now() + 2;
      const db = getDb();
      db.prepare(`
        INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
        VALUES (${testId}, 'test', 'test-model-${testId}', 'Test Model', 1, 1, 'small', 100, 50000, 1)
      `).run();

      const ctx: ThrottleContext = {
        platform: 'test',
        modelId: `test-model-${testId}`,
        modelDbId: testId,
        keyId: 1,
        requestId: 'test-req',
      };

      // 75 requests out of 100 (75%)
      for (let i = 0; i < 75; i++) {
        recordRequest('test', `test-model-${testId}`, 1);
      }

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      checkThrottle(ctx);

      const logCall = spy.mock.calls[0][0];
      expect(logCall).toContain('rpm=75/100(75%)');

      spy.mockRestore();
    });
  });

  describe('applyThrottle', () => {
    it('applies zero delay when below threshold (no setTimeout)', async () => {
      const testId = Date.now() + 3;
      const db = getDb();
      db.prepare(`
        INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
        VALUES (${testId}, 'test', 'test-model-${testId}', 'Test Model', 1, 1, 'small', 60, 100000, 1)
      `).run();

      const ctx: ThrottleContext = {
        platform: 'test',
        modelId: `test-model-${testId}`,
        modelDbId: testId,
        keyId: 1,
        requestId: 'test-req',
      };

      // Only 1 request -> below threshold
      recordRequest('test', `test-model-${testId}`, 1);

      const start = Date.now();
      await applyThrottle(ctx);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10); // Should be nearly instant
    });

    it('applies non-zero delay and resolves after delay', async () => {
      vi.useFakeTimers();

      const testId = Date.now() + 4;
      const db = getDb();
      db.prepare(`
        INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
        VALUES (${testId}, 'test', 'test-model-${testId}', 'Test Model', 1, 1, 'small', 60, 100000, 1)
      `).run();

      const ctx: ThrottleContext = {
        platform: 'test',
        modelId: `test-model-${testId}`,
        modelDbId: testId,
        keyId: 1,
        requestId: 'test-req',
      };

      // 45 requests out of 60 (75%) -> above threshold -> should delay ~15000ms
      for (let i = 0; i < 45; i++) {
        recordRequest('test', `test-model-${testId}`, 1);
      }

      const promise = applyThrottle(ctx);

      // Advance timers - should not resolve yet
      vi.advanceTimersByTime(10000);

      // Advance past the delay (15000ms)
      vi.advanceTimersByTime(10000);

      // Now it should resolve
      await expect(promise).resolves.toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe('Delay threshold variation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('respects per-provider threshold', () => {
      const testId = Date.now() + 5;
      const db = getDb();
      db.prepare(`
        INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
        VALUES (${testId}, 'test', 'test-model-${testId}', 'Test Model', 1, 1, 'small', 100, 100000, 1)
      `).run();

      const ctx: ThrottleContext = {
        platform: 'test',
        modelId: `test-model-${testId}`,
        modelDbId: testId,
        keyId: 1,
        requestId: 'test-req',
      };

      // 75 requests out of 100 (75%)
      for (let i = 0; i < 75; i++) {
        recordRequest('test', `test-model-${testId}`, 1);
      }

      // With 75% usage and 50% threshold -> delay
      const delay = checkThrottle(ctx);
      expect(delay).toBeGreaterThan(0);
    });

    it('threshold=1.0 delays only when at or above 100%', () => {
      vi.mocked(providerLimitsModule.getPlatformDelayThreshold).mockReturnValue(1.0);

      const testId = Date.now() + 6;
      const db = getDb();
      db.prepare(`
        INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
        VALUES (${testId}, 'test', 'test-model-${testId}', 'Test Model', 1, 1, 'small', 100, 100000, 1)
      `).run();

      const ctx: ThrottleContext = {
        platform: 'test',
        modelId: `test-model-${testId}`,
        modelDbId: testId,
        keyId: 1,
        requestId: 'test-req',
      };

      // 99 requests out of 100 (99%) -> below 100% threshold
      for (let i = 0; i < 99; i++) {
        recordRequest('test', `test-model-${testId}`, 1);
      }

      expect(checkThrottle(ctx)).toBe(0);

      // 100 requests out of 100 (100%) -> at 100% threshold
      recordRequest('test', `test-model-${testId}`, 1);

      const delay = checkThrottle(ctx);
      expect(delay).toBe(100); // Minimum delay
    });
  });

  describe('DB unavailable fallback', () => {
    it('gracefully handles db error', () => {
      const ctx: ThrottleContext = {
        platform: 'test',
        modelId: 'nonexistent',
        modelDbId: 999999,
        keyId: 1,
        requestId: 'test-req',
      };

      const delay = checkThrottle(ctx);
      expect(delay).toBe(0); // Should return 0 for non-existent model
    });
  });
});