import { describe, it, expect, afterEach, vi } from 'vitest';

// #1593: the health pass cadence was a hardcoded 5 minutes, which operators on
// providers that dislike frequent key checks cannot slow down.
// HEALTH_CHECK_INTERVAL_MS now configures it, with a 60s floor so a
// typo can never turn the pass into provider-visible flood. The constants are
// read at module load, so every case re-imports the module with a fresh cache.

const DEFAULT_MS = 5 * 60 * 1000;

async function loadHealth() {
  vi.resetModules();
  return import('../../services/health.js');
}

describe('HEALTH_CHECK_INTERVAL_MS env (#1593)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 5 minutes when unset', async () => {
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(DEFAULT_MS);
  });

  it('honours a slower cadence', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS', '1800000'); // 30 min
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(1_800_000);
    // The jittered next-pass delay follows the configured cadence.
    expect(m.nextHealthCheckDelayMs(() => 0.5)).toBe(1_800_000);
  });

  it('honours a faster cadence down to the 60s floor', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS', '60000');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(60_000);
    // The recency skip must stay under the interval or passes skip whole keys.
    expect(m.RECENT_CHECK_SKIP_MS).toBeLessThan(m.HEALTH_CHECK_INTERVAL_MS);
  });

  it('falls back to the default below the floor (flood guard)', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS', '1000');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(DEFAULT_MS);
  });

  it('ignores junk values', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS', 'not-a-number');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(DEFAULT_MS);
  });
});
