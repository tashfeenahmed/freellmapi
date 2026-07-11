import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { startHealthChecker, stopHealthChecker } from '../../services/health.js';
import type { Scheduler } from '../../lib/scheduler.js';

function makeScheduler() {
  const every: { ms: number; fn: () => void | Promise<void> }[] = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const scheduler: Scheduler = {
    every(ms, fn) {
      const cancel = vi.fn();
      every.push({ ms, fn });
      cancels.push(cancel);
      return cancel;
    },
    after(_ms, _fn) {
      return vi.fn();
    },
  };
  return { scheduler, every, cancels };
}

describe('startHealthChecker / stopHealthChecker', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    stopHealthChecker();
  });

  it('registers one every-5-minute job', () => {
    const { scheduler, every } = makeScheduler();
    startHealthChecker(scheduler);
    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(5 * 60 * 1000);
  });

  it('is idempotent — double-start registers only one job', () => {
    const { scheduler, every } = makeScheduler();
    startHealthChecker(scheduler);
    startHealthChecker(scheduler);
    expect(every).toHaveLength(1);
  });

  it('stop invokes the cancel handle', () => {
    const { scheduler, cancels } = makeScheduler();
    startHealthChecker(scheduler);
    stopHealthChecker();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it('can re-register after stop', () => {
    const { scheduler: s1 } = makeScheduler();
    startHealthChecker(s1);
    stopHealthChecker();

    const { scheduler: s2, every } = makeScheduler();
    startHealthChecker(s2);
    expect(every).toHaveLength(1);
  });

  it('the registered job runs checkAllKeys without throwing', async () => {
    const { scheduler, every } = makeScheduler();
    startHealthChecker(scheduler);
    await expect(every[0].fn()).resolves.toBeUndefined();
  });
});
