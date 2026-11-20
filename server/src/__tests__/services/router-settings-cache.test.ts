import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  routeRequest,
  setRouterSettingsCacheForTests,
  setRoutingStrategy,
  getRoutingStrategy,
} from '../../services/router.js';

// routeRequest runs once per failover attempt. The settings it consults must be
// read from the snapshot, not re-SELECTed on every attempt.
describe('routing settings snapshot', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setRouterSettingsCacheForTests(true);
  });

  afterAll(() => {
    setRouterSettingsCacheForTests(false);
  });

  function settingsSelects(run: () => void): number {
    const db = getDb();
    const original = db.prepare.bind(db);
    let n = 0;
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (/FROM settings WHERE key = \?/.test(sql)) n++;
      return original(sql);
    }) as typeof db.prepare);
    try { run(); } finally { spy.mockRestore(); }
    return n;
  }

  const attempt = () => { try { routeRequest(1000); } catch { /* no keys configured: only the reads matter */ } };

  it('reads each setting at most once across several routeRequest calls within the TTL', () => {
    attempt(); // warm the snapshot
    const reads = settingsSelects(() => { for (let i = 0; i < 5; i++) attempt(); });
    expect(reads).toBe(0);
  });

  it('issues far fewer settings reads than uncached attempts would', () => {
    setRouterSettingsCacheForTests(false);
    const uncachedOnce = settingsSelects(attempt);
    setRouterSettingsCacheForTests(true);
    const cachedFive = settingsSelects(() => { for (let i = 0; i < 5; i++) attempt(); });
    expect(uncachedOnce).toBeGreaterThan(0);
    expect(cachedFive).toBeLessThanOrEqual(uncachedOnce);
  });

  it('a routing setting write is visible immediately despite the snapshot', () => {
    setRoutingStrategy('fastest');
    expect(getRoutingStrategy()).toBe('fastest');
    setRoutingStrategy('smartest');
    expect(getRoutingStrategy()).toBe('smartest');
  });
});
