import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// HTTP 405 (Method Not Allowed) on an upstream chat endpoint: the entrance
// refused the POST (login page / WAF / wrong base path). Before this change the
// error was classified FATAL, so a ladder that had already failed over was
// stranded on the dead entrance and the client got a 502. These tests pin the
// new behaviour: retryable, named in the trail, the refusing entrance ruled out
// for the request (every row of a custom relay, only the row when it cannot
// name its relay, the whole provider for a catalogue platform), exempt from the
// breaker, and the terminal body honest while the status stays the generic 502.

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({
  checkKeyHealth: mockCheckKeyHealth,
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import {
  runFallbackLoop,
  newFallbackState,
  exhaustedRetryError,
  classifyAttemptError,
  recordRetryableFailure,
  type AttemptRecord,
  type FallbackHooks,
} from '../../lib/fallback-loop.js';
import { isRetryableError, isMethodNotAllowedError } from '../../lib/error-classify.js';
import type { RouteResult } from '../../services/router.js';

let keySeq = 98_000;
function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any,
    modelId: 'fake-model',
    modelDbId: 982000 + n,
    apiKey: 'k',
    keyId: n,
    keyLabel: null,
    platform: 'fake',
    displayName: 'Fake Model',
    contextWindow: null,
    endpointScope: '',
    rpdLimit: null,
    tpdLimit: null,
    ...overrides,
  } as RouteResult;
}

/** A custom model row that the per-request relay expansion can find. */
function addCustomModel(modelId: string, endpointScope: string): number {
  const info = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, endpoint_scope)
    VALUES ('custom', ?, ?, 50, 50, 'Medium', 1, ?)
  `).run(modelId, modelId, endpointScope);
  return Number(info.lastInsertRowid);
}

// Shape a real relay produces: HTTP 405 plus the gateway's HTML error page.
const html405 = () => Object.assign(
  new Error('Custom (OpenAI-compatible) API error 405: <!doctype html><html lang="zh-cn"><title>405</title>'),
  { status: 405, providerRejection: 'upstream' as const },
);

const html500 = () => Object.assign(
  new Error('Custom (OpenAI-compatible) API error 500: upstream exploded'),
  { status: 500, providerRejection: 'upstream' as const },
);

function hooksSkeleton(overrides: Partial<FallbackHooks>): FallbackHooks {
  return {
    state: newFallbackState(),
    timeBudgetMs: 0,
    route: () => fakeRoute(),
    dispatch: async () => 'done',
    logFailure: () => {},
    onFatal: () => {},
    onRoutingExhausted: () => {},
    onExhausted: () => {},
    ...overrides,
  };
}

const record = (classes: AttemptRecord['errorClass'][][]): AttemptRecord[] =>
  classes.flat().map((errorClass, i) => ({ platform: 'fake', modelId: `m${i}`, keyOrdinal: i + 1, errorClass }));

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  mockCheckKeyHealth.mockReset();
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  getDb().prepare("DELETE FROM models WHERE platform = 'custom'").run();
  getDb().prepare("DELETE FROM settings WHERE key = 'max_consecutive_upstream_fails'").run();
});

describe('405 classification', () => {
  it('treats a structured 405 as retryable and names it in the trail', () => {
    expect(isMethodNotAllowedError(html405())).toBe(true);
    expect(isRetryableError(html405())).toBe(true);
    expect(classifyAttemptError(html405())).toBe('method_not_allowed');
  });

  it('matches adapters that only format the code into the message', () => {
    expect(isMethodNotAllowedError(new Error('Custom (OpenAI-compatible) API error 405: nope'))).toBe(true);
    expect(isMethodNotAllowedError(new Error('upstream said: Method Not Allowed'))).toBe(true);
  });

  it('does not read a number in prose as a 405', () => {
    // Token counts / ports / model names with 405 in them are not a method
    // rejection: the fallback must be anchored on the "api error"/"status"
    // shape, never a bare \b405\b.
    expect(isMethodNotAllowedError(new Error('maximum context length is 405 tokens'))).toBe(false);
    expect(isMethodNotAllowedError(new Error('connect ECONNREFUSED 127.0.0.1:405'))).toBe(false);
    expect(isMethodNotAllowedError(Object.assign(new Error('API error 400: bad params'), { status: 400 }))).toBe(false);
  });
});

describe('405 terminal body', () => {
  it('keeps the generic 502/upstream_failed but stops telling the caller to retry', () => {
    const body = exhaustedRetryError(html405(), 20, { attempts: record(['method_not_allowed', 'method_not_allowed']) });
    expect(body.status).toBe(502);
    expect(body.code).toBe('upstream_failed');
    expect(body.kind).toBe('upstream');
    expect(body.message).toContain('Method Not Allowed');
    expect(body.message).toContain('base URL');
    expect(body.message).not.toContain('retry, or check provider status');
  });

  it('a mixed trail keeps the generic 502 wording', () => {
    const body = exhaustedRetryError(html405(), 20, { attempts: record(['method_not_allowed', 'rate_limited']) });
    expect(body.status).toBe(502);
    expect(body.code).toBe('upstream_failed');
    expect(body.message).toContain('provider-side failure');
    expect(body.message).not.toContain('does not accept this POST');
  });
});

describe('405 failover + bookkeeping', () => {
  it('fails over to the next hop instead of rendering a fatal 502', async () => {
    const routes = [
      fakeRoute({ platform: 'custom', modelId: 'glm-5.3', endpointScope: 'https://relay.example/v1' }),
      fakeRoute({ platform: 'unorouter', modelId: 'glm-5.3-flash:free' }),
    ];
    const dispatch = vi.fn()
      .mockRejectedValueOnce(html405())
      .mockResolvedValueOnce('done');
    const onFatal = vi.fn();
    const onExhausted = vi.fn();

    await runFallbackLoop(hooksSkeleton({
      route: attempt => routes[Math.min(attempt, routes.length - 1)],
      dispatch,
      onFatal,
      onExhausted,
    }));

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(onFatal).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('expands a 405 on a custom relay into every model row of that relay', () => {
    const scope = 'https://relay-405.example/v1';
    const siblingScope = 'https://healthy-relay.example/v1';
    const relayRows = [
      addCustomModel('glm-5.3', scope),
      addCustomModel('glm-5.3-flash', scope),
      addCustomModel('qwen3-coder', scope),
    ];
    const healthyRow = addCustomModel('glm-5.3', siblingScope);

    const route = fakeRoute({
      platform: 'custom',
      modelId: 'glm-5.3',
      modelDbId: relayRows[0],
      endpointScope: scope,
    });
    const state = newFallbackState();
    const exempt = recordRetryableFailure(route, html405(), state);

    // Exempt = no model penalty and no breaker credit; one relay's WAF says
    // nothing about the pool.
    expect(exempt).toBe(true);
    // Same request, endpoint-equivalent: every row on the relay is out, the
    // sibling relay's rows are not, and the whole platform is never skipped.
    for (const id of relayRows) expect(state.skipModels.has(id)).toBe(true);
    expect(state.skipModels.has(healthyRow)).toBe(false);
    expect(state.skipPlatforms.size).toBe(0);

    // No per-model cooldown: benching one row per relay model would not reduce
    // the cost; endpoint-level cooling is a separate follow-up.
    const cooldown = getDb().prepare(
      'SELECT 1 FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?',
    ).get(route.platform, route.modelId, route.keyId);
    expect(cooldown).toBeUndefined();
  });

  it('a custom row with no endpoint scope skips only itself, never the platform', () => {
    const route = fakeRoute({ platform: 'custom', modelId: 'legacy-custom-row', endpointScope: '' });
    const state = newFallbackState();

    expect(recordRetryableFailure(route, html405(), state)).toBe(true);
    expect(state.skipModels.has(route.modelDbId)).toBe(true);
    // The one 'custom' platform id covers every relay; a legacy row must not
    // take them all down with it.
    expect(state.skipPlatforms.size).toBe(0);
  });

  it('rules out a non-custom provider wholesale (one entrance per platform)', () => {
    const route = fakeRoute({ platform: 'unorouter', modelId: 'glm-5.3-flash:free' });
    const state = newFallbackState();

    expect(recordRetryableFailure(route, html405(), state)).toBe(true);
    expect(state.skipPlatforms.has('unorouter')).toBe(true);
    expect(state.skipModels.size).toBe(0);
  });

  it('does not count 405s toward the circuit breaker', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('max_consecutive_upstream_fails', '2')").run();
    const dispatch = vi.fn()
      .mockRejectedValueOnce(html405())
      .mockRejectedValueOnce(html405())
      .mockRejectedValueOnce(html405())
      .mockResolvedValueOnce('done');
    const onExhausted = vi.fn();

    await runFallbackLoop(hooksSkeleton({
      route: () => fakeRoute({ platform: 'custom', endpointScope: 'https://relay.example/v1' }),
      dispatch,
      onExhausted,
    }));

    // Three 405s would trip a limit-2 breaker if they counted; the ladder keeps
    // going and the fourth hop answers.
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(onExhausted).not.toHaveBeenCalled();
  });
});

// #1901 will narrow custom 5xx to endpoint scope. This test pins the CURRENT
// platform-wide behaviour so that change has to be an explicit decision, not an
// accident of the 405 branch sitting next to it.
describe('5xx regression (adjacent branch unchanged)', () => {
  it('a custom 5xx still rules out the whole platform and is not exempt', () => {
    const route = fakeRoute({ platform: 'custom', modelId: 'glm-5.3', endpointScope: 'https://relay.example/v1' });
    const state = newFallbackState();

    expect(recordRetryableFailure(route, html500(), state)).toBe(false);
    expect(state.skipPlatforms.has('custom')).toBe(true);
    expect(state.skipModels.size).toBe(0);
  });
});
