import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { initDb, setSetting } from '../../db/index.js';
import { syncCatalog } from '../../services/catalog-sync.js';

// M11: the 12 h tick, POST /api/premium/sync, key add/remove and declarative
// license config all call syncCatalog with no guard, so two runs could fetch
// and apply side by side. Callers now share the run in flight; a forced call
// (a license change) queues one fresh run behind it, since the run in flight
// read the old key.

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  setSetting('catalog_applied_version', '2099.01.01');
});

afterEach(() => { vi.restoreAllMocks(); });

/** fetch that answers 304 only when the test releases each call. */
function gatedFetch() {
  const releases: Array<() => void> = [];
  const spy = vi.spyOn(global, 'fetch').mockImplementation(() =>
    new Promise<Response>(resolve => { releases.push(() => resolve(new Response(null, { status: 304 }))); }));
  const releaseNext = async () => {
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    releases.shift()!();
  };
  return { spy, releaseNext };
}

it('shares one run between callers that overlap', async () => {
  const { spy, releaseNext } = gatedFetch();
  const a = syncCatalog();
  const b = syncCatalog();
  await releaseNext();
  const [ra, rb] = await Promise.all([a, b]);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(rb).toEqual(ra);
});

it('a forced sync during a run queues exactly one fresh forced run after it', async () => {
  const { spy, releaseNext } = gatedFetch();
  const tick = syncCatalog();
  const forced1 = syncCatalog(true);
  const forced2 = syncCatalog(true);

  expect(spy).toHaveBeenCalledTimes(1);
  await releaseNext();
  await tick;
  // The queued forced run starts as soon as the first one settles: one more
  // fetch for both forced callers, not one each.
  await releaseNext();
  await Promise.all([forced1, forced2]);
  expect(spy).toHaveBeenCalledTimes(2);
  // The queued run is forced: it skips the `since` short-circuit.
  expect(String(spy.mock.calls[1]![0])).not.toContain('since=');
});

it('starts a new run once the previous one has finished', async () => {
  const { spy, releaseNext } = gatedFetch();
  const first = syncCatalog();
  await releaseNext();
  await first;
  const second = syncCatalog();
  await releaseNext();
  await second;
  expect(spy).toHaveBeenCalledTimes(2);
});
