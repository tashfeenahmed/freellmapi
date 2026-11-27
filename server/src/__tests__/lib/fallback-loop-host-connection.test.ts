import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// #2080: a connection reset to integrate.api.nvidia.com ended a request after
// one attempt, and the next request picked the next NVIDIA model and hit the
// same dead host again ("it keeps switching models inside the provider instead
// of switching provider"). A connection-level failure is about the HOST, which
// serves every model of the platform, so the key is benched on all of the
// platform's models at once. And when routing runs dry after attempts, the
// exhaustion says why failover stopped instead of a bare one-hop trail.

vi.mock('../../services/health.js', () => ({
  checkKeyHealth: vi.fn(),
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  newFallbackState,
  recordRetryableFailure,
  resetModelFailureWindows,
  runFallbackLoop,
  failoverDeadEndNote,
  type ExhaustionBody,
  type FallbackHooks,
} from '../../lib/fallback-loop.js';
import { isHostConnectionError, isRetryableError, isProviderLevelError } from '../../lib/error-classify.js';
import { isOnCooldown, clearCooldownsForKey, resetKeyLocalityCache } from '../../services/ratelimit.js';
import { newHedgeAbortError, newClientAbortError } from '../../lib/error-classify.js';
import type { RouteResult } from '../../services/router.js';

const PLATFORM = 'nvidia';
let keyA = 0;
let keyB = 0;
let models: { id: number; model_id: string }[] = [];

function insertKey(platform: string, label: string): number {
  const { encrypted, iv, authTag } = encrypt(`test-${label}`);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, label, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

function routeFor(model: { id: number; model_id: string }, keyId: number, platform = PLATFORM): RouteResult {
  return {
    provider: {} as any,
    modelId: model.model_id,
    modelDbId: model.id,
    apiKey: 'k',
    keyId,
    platform,
    displayName: model.model_id,
    rpdLimit: null,
    tpdLimit: null,
  };
}

// The shape undici + describeFetchFailure (lib/proxy.ts) produce for the issue.
const RESET = () => {
  const err = new TypeError('fetch failed (ECONNRESET integrate.api.nvidia.com)');
  (err as any).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  return err;
};

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  keyA = insertKey(PLATFORM, 'key-a');
  keyB = insertKey(PLATFORM, 'key-b');
  resetKeyLocalityCache();
  models = db.prepare(
    'SELECT id, model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY id',
  ).all(PLATFORM) as { id: number; model_id: string }[];
  expect(models.length).toBeGreaterThanOrEqual(3);
});

beforeEach(() => {
  clearCooldownsForKey(keyA);
  clearCooldownsForKey(keyB);
  resetModelFailureWindows();
});

describe('isHostConnectionError', () => {
  it('matches resets, refusals, DNS and never-opened connections', () => {
    expect(isHostConnectionError(RESET())).toBe(true);
    expect(isHostConnectionError(new TypeError('fetch failed'))).toBe(true);
    expect(isHostConnectionError(new TypeError('fetch failed (ENOTFOUND integrate.api.nvidia.com)'))).toBe(true);
    expect(isHostConnectionError(Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    }))).toBe(true);
    expect(isHostConnectionError(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('does not match a slow model, an HTTP answer, or the gateway\'s own aborts', () => {
    expect(isHostConnectionError(new Error('upstream timeout after 60000ms'))).toBe(false);
    expect(isHostConnectionError(Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(false);
    expect(isHostConnectionError(new TypeError('terminated'))).toBe(false);
    expect(isHostConnectionError(Object.assign(new Error('API error 502: ECONNRESET from origin'), { status: 502 }))).toBe(false);
    expect(isHostConnectionError(newHedgeAbortError())).toBe(false);
    expect(isHostConnectionError(newClientAbortError())).toBe(false);
    expect(isHostConnectionError(null)).toBe(false);
  });

  it('agrees with the existing failover classifiers on the issue error', () => {
    expect(isRetryableError(RESET())).toBe(true);
    expect(isProviderLevelError(RESET())).toBe(true);
  });
});

describe('a connection reset benches the key on the whole platform', () => {
  it('cools every enabled model of the platform on the failing key and rules the platform out', () => {
    const state = newFallbackState();
    recordRetryableFailure(routeFor(models[0], keyA), RESET(), state);
    for (const m of models) {
      expect(isOnCooldown(PLATFORM, m.model_id, keyA), m.model_id).toBe(true);
    }
    expect(state.skipPlatforms.has(PLATFORM)).toBe(true);
  });

  it('leaves a sibling key on the same platform alone (it may use another proxy)', () => {
    recordRetryableFailure(routeFor(models[0], keyA), RESET(), newFallbackState());
    for (const m of models) {
      expect(isOnCooldown(PLATFORM, m.model_id, keyB), m.model_id).toBe(false);
    }
  });

  it('keeps a timeout on the per-model path', () => {
    const state = newFallbackState();
    recordRetryableFailure(routeFor(models[0], keyA), new Error('upstream timeout after 60000ms'), state);
    expect(isOnCooldown(PLATFORM, models[0].model_id, keyA)).toBe(true);
    expect(isOnCooldown(PLATFORM, models[1].model_id, keyA)).toBe(false);
  });

  it('never benches other custom relays, which share the platform id', () => {
    const keyC = insertKey('custom', 'relay');
    const ins = getDb().prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('custom', ?, ?, 50, 5, 1)");
    const relayA = Number(ins.run('relay-a-model', 'relay-a-model').lastInsertRowid);
    ins.run('relay-b-model', 'relay-b-model');
    try {
      recordRetryableFailure(routeFor({ id: relayA, model_id: 'relay-a-model' }, keyC, 'custom'), RESET(), newFallbackState());
      expect(isOnCooldown('custom', 'relay-a-model', keyC)).toBe(true);
      expect(isOnCooldown('custom', 'relay-b-model', keyC)).toBe(false);
    } finally {
      clearCooldownsForKey(keyC);
    }
  });
});

describe('exhaustion after attempts explains why failover stopped', () => {
  const routeError = (message: string) => Object.assign(new Error(message), { status: 429, diagnostics: ['x @nvidia: provider ruled out earlier this request'] });

  function run(overrides: Partial<FallbackHooks>): Promise<ExhaustionBody | undefined> {
    let body: ExhaustionBody | undefined;
    let calls = 0;
    const route = routeFor(models[0], keyA);
    return runFallbackLoop({
      state: newFallbackState(),
      timeBudgetMs: 0,
      route: () => {
        if (calls++ === 0) return route;
        throw routeError('All models exhausted: 1 route checked (1 failed earlier this request). Add more API keys or wait for rate limits to reset. 2 models skipped: no key configured for their platform.');
      },
      dispatch: async () => { throw RESET(); },
      logFailure: () => {},
      onFatal: () => {},
      onRoutingExhausted: (_last, _routeErr, exhaustion) => { body = exhaustion; },
      onExhausted: () => {},
      ...overrides,
    }).then(() => body);
  }

  it('names the router\'s reason after the attempt trail', async () => {
    const body = await run({});
    expect(body?.status).toBe(502);
    expect(body?.message).toContain('All 1 routed attempt(s) failed');
    expect(body?.message).toContain('Last error: fetch failed (ECONNRESET integrate.api.nvidia.com). Failover stopped because no other route could take the request: 1 route checked (1 failed earlier this request). 2 models skipped');
    expect(body?.message).not.toContain('Add more API keys');
    expect(body?.message).not.toContain('pinned');
  });

  it('says a strict pin kept failover on that model\'s providers', async () => {
    const body = await run({ strictPinnedModel: 'nvidia/nemotron-3-ultra-550b-a55b' });
    expect(body?.message).toContain("The request pinned model 'nvidia/nemotron-3-ultra-550b-a55b'");
    expect(body?.message).toContain('send model "auto"');
  });

  it('leaves a zero-attempt routing exhaustion unchanged', async () => {
    let body: ExhaustionBody | undefined;
    await runFallbackLoop({
      state: newFallbackState(),
      timeBudgetMs: 0,
      route: () => { throw routeError('All models exhausted: 1 route checked (1 rate-limited or on cooldown).'); },
      dispatch: async () => 'done',
      logFailure: () => {},
      onFatal: () => {},
      onRoutingExhausted: (_last, _routeErr, exhaustion) => { body = exhaustion; },
      onExhausted: () => {},
    });
    expect(body?.message).not.toContain('Failover stopped');
  });

  it('failoverDeadEndNote copes with a RouteError that has no message', () => {
    expect(failoverDeadEndNote(undefined)).toBe(' Failover stopped because no other route could take the request.');
  });
});
