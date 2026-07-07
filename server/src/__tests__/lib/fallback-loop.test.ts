import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Unit tests for the shared fallback loop's PR-B hardening: auth-fatal key
// rotation + immediate revalidation, the attempt trail in exhaustion bodies,
// daily-allocation benching until UTC midnight, the reasoning-truncation
// skipBench exemption, the wall-clock retry budget, and the dispatch-outcome
// contract enforcement.

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({ checkKeyHealth: mockCheckKeyHealth }));

import { initDb, getDb } from '../../db/index.js';
import {
  runFallbackLoop,
  newFallbackState,
  cooldownForError,
  recordRetryableFailure,
  exhaustedRetryError,
  formatAttemptTrail,
  classifyAttemptError,
  msUntilNextUtcMidnight,
  getFallbackTimeBudgetMs,
  DEFAULT_FALLBACK_TIME_BUDGET_MS,
  AUTH_FAILURE_COOLDOWN_MS,
  type AttemptRecord,
  type FallbackHooks,
} from '../../lib/fallback-loop.js';
import { isKeyAuthError, isDailyQuotaExhaustedError } from '../../lib/error-classify.js';
import { getAllPenalties } from '../../services/router.js';
import type { RouteResult } from '../../services/router.js';

// Distinct keyId AND modelDbId per fake route: the router's penalty map and the
// cooldown store are module-global, so shared ids would leak state across tests.
let keySeq = 100;
function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: 'fake-model', modelDbId: 424000 + n, apiKey: 'k',
    keyId: n, platform: 'fake', displayName: 'Fake Model',
    rpdLimit: null, tpdLimit: null,
    ...overrides,
  };
}

function hooksSkeleton(overrides: Partial<FallbackHooks>): FallbackHooks {
  return {
    state: newFallbackState(),
    timeBudgetMs: 0, // disabled unless a test opts in
    route: () => fakeRoute(),
    dispatch: async () => 'done',
    logFailure: () => {},
    onFatal: () => {},
    onRoutingExhausted: () => {},
    onExhausted: () => {},
    ...overrides,
  };
}

const authRecord = (n: number): AttemptRecord[] =>
  Array.from({ length: n }, (_, i) => ({ platform: 'fake', modelId: 'm', keyOrdinal: i + 1, errorClass: 'auth' as const }));

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  mockCheckKeyHealth.mockReset();
  mockCheckKeyHealth.mockResolvedValue('invalid');
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
});

describe('isKeyAuthError (401 = key-fatal, rotate instead of 502)', () => {
  it('flags a structured 401 and common invalid-key phrasings', () => {
    expect(isKeyAuthError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(true);
    expect(isKeyAuthError(new Error('Groq API error 401: Invalid API Key'))).toBe(true);
    expect(isKeyAuthError(new Error('unauthorized'))).toBe(true);
    expect(isKeyAuthError(new Error('invalid_api_key: Incorrect API key provided'))).toBe(true);
  });

  it('does not flag 403s, 429s, or plain validation 400s', () => {
    expect(isKeyAuthError(Object.assign(new Error('forbidden'), { status: 403 }))).toBe(false);
    expect(isKeyAuthError(new Error('429 Too Many Requests'))).toBe(false);
    expect(isKeyAuthError(new Error('400 Bad Request'))).toBe(false);
    // A structured non-401 status wins over a suspicious message.
    expect(isKeyAuthError(Object.assign(new Error('unauthorized model'), { status: 403 }))).toBe(false);
  });

  it('flags Google-style HTTP 400 bad-key errors via key-specific substrings only (#268)', () => {
    // Google reports a bad/expired key as HTTP 400 INVALID_ARGUMENT, and every
    // adapter attaches err.status (providerHttpError), so the 400 path must
    // accept the key-specific phrasings...
    expect(isKeyAuthError(Object.assign(new Error('Google API error 400: API key not valid. Please pass a valid API key.'), { status: 400 }))).toBe(true);
    expect(isKeyAuthError(Object.assign(new Error('Google API error 400: API key expired. Please renew the API key.'), { status: 400 }))).toBe(true);
    expect(isKeyAuthError(Object.assign(new Error('400 INVALID_ARGUMENT: API_KEY_INVALID'), { status: 400 }))).toBe(true);
    // ...while ordinary payload 400s (even with generic auth-ish wording) stay
    // provider-bad-request, not key-auth.
    expect(isKeyAuthError(Object.assign(new Error('Google API error 400: Invalid JSON payload received. Unknown name "x"'), { status: 400 }))).toBe(false);
    expect(isKeyAuthError(Object.assign(new Error('Cerebras API error 400: unauthorized field in tool schema'), { status: 400 }))).toBe(false);
  });
});

describe('isDailyQuotaExhaustedError + midnight benching (drift: 90s cooldown on a dead-for-the-day provider)', () => {
  it('flags real daily-allocation 429 bodies', () => {
    expect(isDailyQuotaExhaustedError(new Error('Cloudflare API error 429: you have used up your daily free allocation of 10,000 neurons'))).toBe(true);
    expect(isDailyQuotaExhaustedError(new Error('Rate limit exceeded: free-models-per-day'))).toBe(true);
    expect(isDailyQuotaExhaustedError(new Error('You have exceeded your daily request limit'))).toBe(true);
  });

  it('does not flag per-minute 429s or generic errors', () => {
    expect(isDailyQuotaExhaustedError(new Error('429 Too Many Requests'))).toBe(false);
    expect(isDailyQuotaExhaustedError(new Error('tokens per minute (TPM): Limit 30000, Requested 33476'))).toBe(false);
    expect(isDailyQuotaExhaustedError(new Error('503 Service Unavailable'))).toBe(false);
  });

  it('cooldownForError benches a daily-allocation 429 until the next UTC midnight', () => {
    const route = fakeRoute();
    const err = Object.assign(new Error('you have used up your daily free allocation of 10,000 neurons'), { status: 429 });
    const ms = cooldownForError(route, err);
    expect(Math.abs(ms - msUntilNextUtcMidnight())).toBeLessThan(5_000);
    expect(ms).toBeGreaterThanOrEqual(60_000);
  });

  it('msUntilNextUtcMidnight floors at one minute near midnight', () => {
    const justBeforeMidnight = Date.UTC(2026, 6, 7, 23, 59, 59, 900);
    expect(msUntilNextUtcMidnight(justBeforeMidnight)).toBe(60_000);
  });

  it('honors an explicit Retry-After over the midnight bench (rolling daily windows)', () => {
    // Groq-style rolling RPD: the body names a daily limit AND the response
    // carries Retry-After ("try again in 7m12s"). The provider knows its own
    // reset time; benching to UTC midnight would over-bench by hours.
    const route = fakeRoute();
    const retryAfterMs = 432_000; // 7m12s
    const err = Object.assign(
      new Error('Groq API error 429: Rate limit reached on requests per day (RPD): Limit 1000. Please try again in 7m12s.'),
      { status: 429, retryAfterMs },
    );
    expect(cooldownForError(route, err)).toBe(retryAfterMs);
  });
});

describe('recordRetryableFailure skipBench exemption (reasoning truncation)', () => {
  it('skips cooldown + penalty but still rules the key out for this request', () => {
    const route = fakeRoute();
    const state = newFallbackState();
    const err = Object.assign(new Error(`empty completion from ${route.displayName}`), { skipBench: true });
    recordRetryableFailure(route, err, state);

    expect(state.skipKeys.has(`fake:fake-model:${route.keyId}`)).toBe(true);
    const cooldown = getDb().prepare('SELECT 1 FROM rate_limit_cooldowns WHERE platform = ? AND key_id = ?').get('fake', route.keyId);
    expect(cooldown).toBeUndefined();
    expect(getAllPenalties().some(p => p.modelDbId === route.modelDbId)).toBe(false);
  });

  it('control: the same error WITHOUT the flag benches and penalizes as before', () => {
    const route = fakeRoute();
    const state = newFallbackState();
    recordRetryableFailure(route, new Error(`empty completion from ${route.displayName}`), state);

    const cooldown = getDb().prepare('SELECT 1 FROM rate_limit_cooldowns WHERE platform = ? AND key_id = ?').get('fake', route.keyId);
    expect(cooldown).toBeDefined();
    // modelDbId 424242 has no sibling key rows, so the penalty fires.
    expect(getAllPenalties().some(p => p.modelDbId === route.modelDbId)).toBe(true);
  });
});

describe('exhaustedRetryError attempt trail + auth exhaustion', () => {
  it('all-auth attempts produce a distinct 502 provider_error body, not a rate-limit 429', () => {
    const body = exhaustedRetryError(new Error('Groq API error 401: Invalid API Key'), 20, { attempts: authRecord(3) });
    expect(body.kind).toBe('auth');
    expect(body.status).toBe(502);
    expect(body.type).toBe('provider_error');
    expect(body.message).toContain('failed authentication');
    expect(body.message).toContain('Attempt trail:');
    expect(body.message).not.toContain('rate-limited');
  });

  it('mixed attempts keep the rate-limit body and carry the trail + attempt count', () => {
    const attempts: AttemptRecord[] = [
      { platform: 'groq', modelId: 'llama-3.3-70b', keyOrdinal: 1, errorClass: 'rate_limited' },
      { platform: 'cloudflare', modelId: 'qwen', keyOrdinal: 2, errorClass: 'daily_quota_exhausted' },
    ];
    const body = exhaustedRetryError(new Error('429 Too Many Requests'), 20, { attempts });
    expect(body.kind).toBe('rate_limit');
    expect(body.status).toBe(429);
    expect(body.message).toContain('after 2 attempts');
    expect(body.message).toContain('groq/llama-3.3-70b key1: rate_limited');
    expect(body.message).toContain('cloudflare/qwen key2: daily_quota_exhausted');
  });

  it('a timed-out loop says so in the body', () => {
    const body = exhaustedRetryError(new Error('429'), 20, { attempts: authRecord(1), timedOut: true, budgetMs: 45000 });
    expect(body.message).toContain('retry time budget 45s exceeded');
  });

  it('provider-invalid exhaustion keeps the 400 invalid_request body (unchanged contract)', () => {
    const err = Object.assign(new Error('Google API error 400: Invalid JSON payload received'), { status: 400 });
    const body = exhaustedRetryError(err, 20, {
      attempts: [{ platform: 'google', modelId: 'gemini', keyOrdinal: 1, errorClass: 'provider_bad_request' }],
    });
    expect(body.status).toBe(400);
    expect(body.type).toBe('invalid_request_error');
    expect(body.message).toContain('rejected the request as invalid');
    expect(body.message).toContain('Attempt trail:');
  });

  it('formatAttemptTrail caps the shown entries', () => {
    const trail = formatAttemptTrail(authRecord(14));
    expect(trail).toContain('+4 more');
  });

  it('classifyAttemptError distinguishes the interesting classes', () => {
    expect(classifyAttemptError(Object.assign(new Error('x'), { status: 401 }))).toBe('auth');
    expect(classifyAttemptError(new Error('HuggingFace Router API error 402: Payment required'))).toBe('out_of_credits');
    expect(classifyAttemptError(new Error('used up your daily free allocation'))).toBe('daily_quota_exhausted');
    expect(classifyAttemptError(new Error('empty completion from X'))).toBe('empty_completion');
    expect(classifyAttemptError(new Error('429 Too Many Requests'))).toBe('rate_limited');
    expect(classifyAttemptError(Object.assign(new Error('Bad Gateway'), { status: 502 }))).toBe('upstream_error');
  });
});

describe('runFallbackLoop: auth rotation (401 is key-fatal, not request-fatal)', () => {
  it('rotates past a 401 key, benches it, and fires an immediate revalidation', async () => {
    const badRoute = fakeRoute();
    const goodRoute = fakeRoute();
    const routes = [badRoute, goodRoute];
    const dispatch = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Invalid API Key'), { status: 401 }))
      .mockResolvedValueOnce('done');
    const onFatal = vi.fn();
    const state = newFallbackState();

    await runFallbackLoop(hooksSkeleton({
      state,
      route: (attempt) => routes[attempt],
      dispatch,
      onFatal,
    }));

    expect(dispatch).toHaveBeenCalledTimes(2);      // rotated instead of 502
    expect(onFatal).not.toHaveBeenCalled();
    expect(state.skipKeys.has(`fake:fake-model:${badRoute.keyId}`)).toBe(true);
    expect(mockCheckKeyHealth).toHaveBeenCalledWith(badRoute.keyId);
    // Benched to cover the window until revalidation flips the key status.
    const row = getDb().prepare('SELECT expires_at_ms FROM rate_limit_cooldowns WHERE platform = ? AND key_id = ?').get('fake', badRoute.keyId) as { expires_at_ms: number };
    expect(row.expires_at_ms - Date.now()).toBeGreaterThan(AUTH_FAILURE_COOLDOWN_MS - 10_000);
    // A key problem is not a model problem: no model penalty.
    expect(getAllPenalties().some(p => p.modelDbId === badRoute.modelDbId)).toBe(false);
  });
});

describe('runFallbackLoop: wall-clock retry budget', () => {
  it('stops starting new attempts once the budget is spent and reports timedOut', async () => {
    const dispatch = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 25));
      throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    });
    const onExhausted = vi.fn();

    await runFallbackLoop(hooksSkeleton({
      timeBudgetMs: 20, // spent after the first ~25ms attempt
      dispatch,
      onExhausted,
    }));

    expect(dispatch).toHaveBeenCalledTimes(1); // first attempt always runs, no second start
    expect(onExhausted).toHaveBeenCalledTimes(1);
    const [body, info] = onExhausted.mock.calls[0];
    expect(info.timedOut).toBe(true);
    expect(body.message).toContain('retry time budget');
    expect(info.attempts).toHaveLength(1);
  });

  it('budget 0 disables the check', async () => {
    const dispatch = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 5));
      throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    });
    const onExhausted = vi.fn();

    await runFallbackLoop(hooksSkeleton({
      maxRetries: 3,
      timeBudgetMs: 0,
      dispatch,
      onExhausted,
    }));

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(onExhausted.mock.calls[0][1].timedOut).toBe(false);
  });

  it('getFallbackTimeBudgetMs: env var wins over the default; setting wins over env', () => {
    const original = process.env.FALLBACK_TIME_BUDGET_MS;
    try {
      delete process.env.FALLBACK_TIME_BUDGET_MS;
      expect(getFallbackTimeBudgetMs()).toBe(DEFAULT_FALLBACK_TIME_BUDGET_MS);
      process.env.FALLBACK_TIME_BUDGET_MS = '12345';
      expect(getFallbackTimeBudgetMs()).toBe(12345);
      getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('fallback_time_budget_ms', '999')").run();
      expect(getFallbackTimeBudgetMs()).toBe(999);
    } finally {
      getDb().prepare("DELETE FROM settings WHERE key = 'fallback_time_budget_ms'").run();
      if (original === undefined) delete process.env.FALLBACK_TIME_BUDGET_MS;
      else process.env.FALLBACK_TIME_BUDGET_MS = original;
    }
  });
});

describe('runFallbackLoop: dispatch outcome contract', () => {
  it('fails loudly when dispatch returns neither done nor committed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onFatal = vi.fn();
    const logFailure = vi.fn();

    await runFallbackLoop(hooksSkeleton({
      dispatch: (async () => undefined) as any, // a buggy adapter's bare `return`
      onFatal,
      logFailure,
    }));

    expect(consoleError).toHaveBeenCalledWith('[FallbackLoop]', expect.stringContaining('dispatch contract violation'));
    expect(logFailure).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledTimes(1); // rendered as a non-retryable error, not silently swallowed
    consoleError.mockRestore();
  });

  it('never retries a violation whose modelId embeds a retryable-looking digit run', async () => {
    // The violation message contains route.modelId; "mistral-small-2503" holds
    // the substring '503', which the retryable classifier would match if the
    // violation were thrown into the ordinary catch. The guard must bypass
    // classification entirely: immediate onFatal, exactly one dispatch.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onFatal = vi.fn();
    const onExhausted = vi.fn();
    const dispatch = vi.fn(async () => undefined) as any;

    await runFallbackLoop(hooksSkeleton({
      route: () => fakeRoute({ modelId: 'mistral-small-2503' }),
      dispatch,
      onFatal,
      onExhausted,
    }));

    expect(dispatch).toHaveBeenCalledTimes(1);   // no re-dispatch of the buggy adapter
    expect(onFatal).toHaveBeenCalledTimes(1);    // immediate 502 render
    expect(onExhausted).not.toHaveBeenCalled();  // never loops to exhaustion
    expect(onFatal.mock.calls[0][1].message).toContain('dispatch contract violation');
    consoleError.mockRestore();
  });
});
