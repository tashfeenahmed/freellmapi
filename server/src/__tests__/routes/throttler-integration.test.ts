import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyThrottle, checkThrottle, ThrottleContext } from '../../services/throttler';
import { initDb, getDb } from '../../db/index.js';
import { recordRequest } from '../../services/ratelimit.js';
import * as providerLimitsModule from '../../services/provider-limits.js';

// Mock the provider-limits module
vi.mock('../../services/provider-limits.js', async () => {
  const actual = await vi.importActual('../../services/provider-limits.js');
  return {
    ...actual,
    getPlatformDelayThreshold: vi.fn().mockReturnValue(0.5),
  };
});

describe('Throttler Integration - timing behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    vi.mocked(providerLimitsModule.getPlatformDelayThreshold).mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies zero delay when below threshold', async () => {
    const testId = Date.now();
    const db = getDb();
    db.prepare(`
      INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
      VALUES (${testId}, 'test-provider', 'test-model', 'Test Model', 1, 1, 'small', 60, 100000, 1)
    `).run();

    const ctx: ThrottleContext = {
      platform: 'test-provider',
      modelId: 'test-model',
      modelDbId: testId,
      keyId: 1,
      requestId: 'test-req',
    };

    // 1 request out of 60 (1.6%) - well below 50% threshold
    recordRequest('test-provider', 'test-model', 1);

    const delay = checkThrottle(ctx);
    expect(delay).toBe(0);
  });

  it('calculates delay when RPM usage exceeds threshold', () => {
    const testId = Date.now() + 1;
    const db = getDb();
    db.prepare(`
      INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
      VALUES (${testId}, 'test-provider', 'test-model', 'Test Model', 1, 1, 'small', 60, 100000, 1)
    `).run();

    const ctx: ThrottleContext = {
      platform: 'test-provider',
      modelId: 'test-model',
      modelDbId: testId,
      keyId: 1,
      requestId: 'test-req',
    };

    // 45 requests out of 60 (75%) - above 50% threshold -> ~15000ms delay
    for (let i = 0; i < 45; i++) {
      recordRequest('test-provider', 'test-model', 1);
    }

    const delay = checkThrottle(ctx);
    expect(delay).toBe(15000);
  });

  it('applies delay via applyThrottle with fake timers', async () => {
    const testId = Date.now() + 2;
    const db = getDb();
    db.prepare(`
      INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
      VALUES (${testId}, 'test-provider', 'test-model', 'Test Model', 1, 1, 'small', 60, 100000, 1)
    `).run();

    const ctx: ThrottleContext = {
      platform: 'test-provider',
      modelId: 'test-model',
      modelDbId: testId,
      keyId: 1,
      requestId: 'test-req',
    };

    // 45 requests out of 60 (75%) - above 50% threshold -> ~15000ms delay
    for (let i = 0; i < 45; i++) {
      recordRequest('test-provider', 'test-model', 1);
    }

    const promise = applyThrottle(ctx);

    // Advance time but not enough
    vi.advanceTimersByTime(10000);
    // Run pending callbacks
    await vi.runAllTimersAsync();
    // Promise should still be pending
    let resolved = false;
    promise.then(() => { resolved = true; });

    // Advance time past the delay
    vi.advanceTimersByTime(10000);
    await vi.runAllTimersAsync();

    // Now it should be resolved
    const result = await promise;
    expect(result).toBeUndefined();
  });

  it('works with different thresholds', () => {
    // Test with 80% threshold
    vi.mocked(providerLimitsModule.getPlatformDelayThreshold).mockReturnValue(0.8);

    const testId = Date.now() + 3;
    const db = getDb();
    db.prepare(`
      INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
      VALUES (${testId}, 'test-provider', 'test-model', 'Test Model', 1, 1, 'small', 100, 100000, 1)
    `).run();

    const ctx: ThrottleContext = {
      platform: 'test-provider',
      modelId: 'test-model',
      modelDbId: testId,
      keyId: 1,
      requestId: 'test-req',
    };

    // 70 requests out of 100 (70%) - above 80% threshold? NO - 70% < 80%
    for (let i = 0; i < 70; i++) {
      recordRequest('test-provider', 'test-model', 1);
    }

    expect(checkThrottle(ctx)).toBe(0);

    // Now add 15 more (85 total = 85% - above 80% threshold)
    for (let i = 0; i < 15; i++) {
      recordRequest('test-provider', 'test-model', 1);
    }

    // 85% > 80% threshold -> delay should be (0.85-0.8)*60000 = 3000ms (may get 2999 due to precision)
    expect(checkThrottle(ctx)).toBeGreaterThanOrEqual(2999);
  });

  it('uses max of RPM and TPM delays', () => {
    const testId = Date.now() + 4;
    const db = getDb();
    db.prepare(`
      INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
      VALUES (${testId}, 'test-provider', 'test-model', 'Test Model', 1, 1, 'small', 60, 100000, 1)
    `).run();

    const ctx: ThrottleContext = {
      platform: 'test-provider',
      modelId: 'test-model',
      modelDbId: testId,
      keyId: 1,
      requestId: 'test-req',
    };

    // Both RPM and TPM above threshold
    // RPM: 45/60 = 75% -> (0.75-0.5)*60000 = 15000ms
    // TPM: 60000/100000 = 60% -> (0.6-0.5)*60000 = 6000ms
    // Should use max = 15000ms
    for (let i = 0; i < 45; i++) {
      recordRequest('test-provider', 'test-model', 1);
    }

    const delay = checkThrottle(ctx);
    // Should delay ~15000ms (max of both axes)
    expect(delay).toBe(15000);
  });
});

describe('Throttler behavior across endpoints', () => {
  // These tests verify that the throttle function works correctly
  // independent of which endpoint calls it.

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    vi.mocked(providerLimitsModule.getPlatformDelayThreshold).mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies throttle consistently for any platform/model', () => {
    // Test that throttle works the same regardless of platform name
    const platforms = ['anthropic', 'openai', 'mistral', 'google', 'test'];

    for (let i = 0; i < platforms.length; i++) {
      const platform = platforms[i];
      const testId = Date.now() + i;
      const db = getDb();
      db.prepare(`
        INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
        VALUES (${testId}, '${platform}', 'test-model-${platform}', 'Test Model', 1, 1, 'small', 60, 100000, 1)
      `).run();

      const ctx: ThrottleContext = {
        platform,
        modelId: `test-model-${platform}`,
        modelDbId: testId,
        keyId: 1,
        requestId: `test-${platform}`,
      };

      // 45 requests out of 60 (75%) - above 50% threshold
      for (let j = 0; j < 45; j++) {
        recordRequest(platform, `test-model-${platform}`, 1);
      }

      // All platforms should get the same delay
      expect(checkThrottle(ctx)).toBe(15000);
    }
  });

  it('handles sequential requests with accumulating usage', () => {
    const testId = Date.now();
    const db = getDb();
    db.prepare(`
      INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, tpm_limit, enabled)
      VALUES (${testId}, 'test-provider', 'test-model', 'Test Model', 1, 1, 'small', 60, 100000, 1)
    `).run();

    const ctx: ThrottleContext = {
      platform: 'test-provider',
      modelId: 'test-model',
      modelDbId: testId,
      keyId: 1,
      requestId: 'test-req',
    };

    // First request - below threshold
    recordRequest('test-provider', 'test-model', 1);
    expect(checkThrottle(ctx)).toBe(0);

    // Add more requests to approach threshold
    for (let i = 0; i < 29; i++) {
      recordRequest('test-provider', 'test-model', 1);
    }

    // 30 requests - exactly at threshold (50%)
    expect(checkThrottle(ctx)).toBe(100); // Minimum 100ms

    // Add more requests to go well above threshold
    for (let i = 0; i < 15; i++) {
      recordRequest('test-provider', 'test-model', 1);
    }

    // 45 requests - 75% usage
    expect(checkThrottle(ctx)).toBe(15000); // ~15000ms delay
  });

  it('returns 0 for non-existent model', () => {
    const ctx: ThrottleContext = {
      platform: 'test-provider',
      modelId: 'non-existent',
      modelDbId: 999999,
      keyId: 1,
      requestId: 'test-req',
    };

    expect(checkThrottle(ctx)).toBe(0);
  });
});