import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// #1347 (PR 1): with provider-moment attribution enabled, a 429 / 5xx /
// timeout / transport failure still benches the KEY (the cooldown ladder is
// the steering mechanism) but must NOT touch the model's books — the failure
// window and the rate-limit/failure penalties. With the feature off (the
// default) the behaviour is exactly today's.

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({
  checkKeyHealth: mockCheckKeyHealth,
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { newFallbackState, recordRetryableFailure } from '../../lib/fallback-loop.js';
import { getAllPenalties, isProviderMomentAttributionEnabled, type RouteResult } from '../../services/router.js';

// Distinct keyId AND modelDbId per fake route: the router's penalty map and
// the cooldown store are module-global, so shared ids would leak state.
let keySeq = 900000;
function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: 'fake-model', modelDbId: n, apiKey: 'k',
    keyId: n, platform: 'fake', displayName: 'Fake Model',
    rpdLimit: null, tpdLimit: null,
    ...overrides,
  };
}

const err429 = () => Object.assign(new Error('API error 429: rate limit exceeded'), { status: 429 });
const err500 = () => Object.assign(new Error('API error 500: internal error'), { status: 500 });
const errTimeout = () => new Error('Request timeout: no response from upstream');
const errBadReq = () => Object.assign(new Error('API error 400: unknown parameter'), { status: 400 });

function penaltyFor(modelDbId: number) {
  return getAllPenalties().find(p => p.modelDbId === modelDbId);
}

function cooldownCount(route: RouteResult): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns WHERE key_id = ?')
    .get(route.keyId) as { n: number }).n;
}

describe('provider-moment attribution in recordRetryableFailure (#1347 PR 1)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    mockCheckKeyHealth.mockReset();
    mockCheckKeyHealth.mockResolvedValue('invalid');
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    delete process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION;
  });

  afterEach(() => {
    delete process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION;
  });

  it('feature ON: a 429 benches the key but leaves the model penalty untouched', () => {
    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = '1';
    expect(isProviderMomentAttributionEnabled()).toBe(true);

    const route = fakeRoute();
    recordRetryableFailure(route, err429(), newFallbackState());

    expect(penaltyFor(route.modelDbId)).toBeUndefined();
    expect(cooldownCount(route)).toBe(1);
  });

  it('feature OFF (default): a 429 still penalizes the model — current behaviour preserved', () => {
    const route = fakeRoute();
    recordRetryableFailure(route, err429(), newFallbackState());

    expect(penaltyFor(route.modelDbId)).toBeDefined();
    expect(penaltyFor(route.modelDbId)!.penalty).toBeGreaterThan(0);
  });

  it('feature ON: a timeout benches the key but leaves the model penalty untouched', () => {
    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = '1';

    const route = fakeRoute();
    recordRetryableFailure(route, errTimeout(), newFallbackState());

    expect(penaltyFor(route.modelDbId)).toBeUndefined();
    expect(cooldownCount(route)).toBe(1);
  });

  it('feature ON: a 5xx benches the key but leaves the model penalty untouched', () => {
    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = '1';

    const route = fakeRoute();
    recordRetryableFailure(route, err500(), newFallbackState());

    expect(penaltyFor(route.modelDbId)).toBeUndefined();
    expect(cooldownCount(route)).toBe(1);
  });

  it('feature ON: a provider 400 is NOT a provider moment — the model penalty stays', () => {
    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = '1';

    const route = fakeRoute();
    recordRetryableFailure(route, errBadReq(), newFallbackState());

    expect(penaltyFor(route.modelDbId)).toBeDefined();
    expect(penaltyFor(route.modelDbId)!.penalty).toBeGreaterThan(0);
  });
});
