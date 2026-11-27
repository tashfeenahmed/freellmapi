import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { initDb, getSetting } from '../../db/index.js';
import {
  SETTING_LICENSE_KEY,
  catalogFetch,
  getCachedLicenseStatus,
  startCatalogSync,
  stopCatalogSync,
  storeActivatedLicense,
} from '../../services/catalog-sync.js';
import type { Scheduler } from '../../lib/scheduler.js';

function networkFailure(): TypeError {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  return err;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

afterEach(() => {
  stopCatalogSync();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('storeActivatedLicense', () => {
  it('keeps the activation answer when the follow-up check cannot reach the service', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => { throw networkFailure(); }));

    const pending = storeActivatedLicense('fla_TESTKEY', {
      valid: true, plan: 'annual', status: 'active', expiresAt: '2027-11-24T00:14:00.000Z',
    });
    await vi.runAllTimersAsync();
    await pending;

    expect(getSetting(SETTING_LICENSE_KEY)).toBe('fla_TESTKEY');
    expect(getCachedLicenseStatus()).toMatchObject({
      valid: true, plan: 'annual', status: 'active', expiresAt: '2027-11-24T00:14:00.000Z',
    });
  });

  it('lets a reachable check overwrite the activation answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      valid: true, plan: 'annual', status: 'active', expiresAt: '2027-11-24T00:14:00.000Z', cancelAtPeriodEnd: true,
    })));
    await storeActivatedLicense('fla_TESTKEY', { valid: true, plan: 'annual', status: 'active', expiresAt: null });
    expect(getCachedLicenseStatus()).toMatchObject({ cancelAtPeriodEnd: true, expiresAt: '2027-11-24T00:14:00.000Z' });
  });
});

describe('catalogFetch without a fallback (server and Docker)', () => {
  it('retries once after a network-level failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const nodeFetch = vi.fn()
      .mockRejectedValueOnce(networkFailure())
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', nodeFetch);

    const pending = catalogFetch('https://catalog.test/v1/license/check');
    await vi.runAllTimersAsync();
    expect(await (await pending).json()).toEqual({ ok: true });
    expect(nodeFetch).toHaveBeenCalledTimes(2);
  });
});

describe('scheduled sync retries', () => {
  function makeScheduler() {
    const after: { ms: number; fn: () => void | Promise<void> }[] = [];
    const scheduler: Scheduler = {
      every: () => () => {},
      after(ms, fn) {
        after.push({ ms, fn });
        return () => {};
      },
    };
    return { scheduler, after };
  }

  it('tries again in 15 minutes, then 30, after failed syncs instead of waiting 12 hours', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const { scheduler, after } = makeScheduler();
    startCatalogSync(scheduler);

    await after[0].fn(); // boot sync fails
    expect(after[1]?.ms).toBe(15 * 60 * 1000);
    await after[1].fn(); // retry fails again
    expect(after[2]?.ms).toBe(30 * 60 * 1000);
  });

  it('schedules no retry once sync is stopped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const { scheduler, after } = makeScheduler();
    startCatalogSync(scheduler);
    stopCatalogSync();
    await after[0].fn();
    expect(after).toHaveLength(1);
  });
});
