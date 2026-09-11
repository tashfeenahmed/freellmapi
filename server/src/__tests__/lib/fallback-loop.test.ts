import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Unit tests for the shared fallback loop's PR-B hardening: auth-fatal key
// rotation + immediate revalidation, the attempt trail in exhaustion bodies,
// daily-allocation benching until UTC midnight, the reasoning-truncation
// skipBench exemption, the wall-clock retry budget, and the dispatch-outcome
// contract enforcement.

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({
  checkKeyHealth: mockCheckKeyHealth,
  // recordUpstreamSuccess touches this on the streak-reset test path.
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import {
  runFallbackLoop,
  newFallbackState,
  cooldownForError,
  recordRetryableFailure,
  recordUpstreamSuccess,
  resetEmptyCompletionStreaks,
  exhaustedRetryError,
  formatAttemptTrail,
  classifyAttemptError,
  msUntilNextUtcMidnight,
  getFallbackTimeBudgetMs,
  DEFAULT_FALLBACK_TIME_BUDGET_MS,
  AUTH_FAILURE_COOLDOWN_MS,
  EMPTY_COMPLETION_STREAK_LIMIT,
  type AttemptRecord,
  type FallbackHooks,
  type FallbackState,
} from '../../lib/fallback-loop.js';
import {
  isKeyAuthError,
  isDailyQuotaExhaustedError,
  isProviderLevelError,
  newClientAbortError,
} from '../../lib/error-classify.js';
import { invalidToolArgumentsError } from '../../lib/tool-validate.js';
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
  resetEmptyCompletionStreaks();
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

  it('skipModelForRequest rules out the whole model, not just the key', () => {
    // Format-ignore is MODEL behavior: a sibling key reproduces it exactly, so
    // burning one failover hop per key on the same model was pure waste.
    const route = fakeRoute();
    const state = newFallbackState();
    const err = Object.assign(
      new Error(`${route.displayName} ignored response_format (returned non-JSON despite json_schema)`),
      { skipBench: true, skipModelForRequest: true },
    );
    recordRetryableFailure(route, err, state);

    expect(state.skipModels.has(route.modelDbId)).toBe(true);
    expect(state.skipKeys.has(`fake:fake-model:${route.keyId}`)).toBe(true);
    // skipBench still applies: no cooldown, no penalty.
    const cooldown = getDb().prepare('SELECT 1 FROM rate_limit_cooldowns WHERE platform = ? AND key_id = ?').get('fake', route.keyId);
    expect(cooldown).toBeUndefined();
    expect(getAllPenalties().some(p => p.modelDbId === route.modelDbId)).toBe(false);
  });

  it('classifyAttemptError buckets format-ignore and truncated-JSON as format_ignored', () => {
    expect(classifyAttemptError(new Error('X ignored response_format (returned non-JSON despite json_object)'))).toBe('format_ignored');
    expect(classifyAttemptError(new Error('truncated JSON from X (finish_reason=length — raise max_tokens for this json_schema request)'))).toBe('format_ignored');
  });
});

describe('empty-completion streak lifts the skipBench exemption (#751)', () => {
  const emptyLengthErr = (route: RouteResult) =>
    Object.assign(new Error(`empty completion from ${route.displayName}`), { skipBench: true });
  const cooldownFor = (route: RouteResult) =>
    getDb().prepare('SELECT 1 FROM rate_limit_cooldowns WHERE platform = ? AND key_id = ?').get('fake', route.keyId);

  it('benches + penalizes from the Nth consecutive empty completion on the same model+key', () => {
    const route = fakeRoute();
    for (let i = 1; i < EMPTY_COMPLETION_STREAK_LIMIT; i++) {
      expect(recordRetryableFailure(route, emptyLengthErr(route), newFallbackState())).toBe(true);
      expect(cooldownFor(route)).toBeUndefined();
    }
    // Streak limit reached: the exemption lifts and the normal path runs.
    expect(recordRetryableFailure(route, emptyLengthErr(route), newFallbackState())).toBe(false);
    expect(cooldownFor(route)).toBeDefined();
    expect(getAllPenalties().some(p => p.modelDbId === route.modelDbId)).toBe(true);
  });

  it('a success on the model+key resets the streak', () => {
    const route = fakeRoute();
    for (let i = 1; i < EMPTY_COMPLETION_STREAK_LIMIT; i++) {
      recordRetryableFailure(route, emptyLengthErr(route), newFallbackState());
    }
    recordUpstreamSuccess(route, 0);
    // The full pre-limit run is available again.
    for (let i = 1; i < EMPTY_COMPLETION_STREAK_LIMIT; i++) {
      expect(recordRetryableFailure(route, emptyLengthErr(route), newFallbackState())).toBe(true);
    }
    expect(cooldownFor(route)).toBeUndefined();
  });

  it('a normally-penalized failure resets the streak too', () => {
    const route = fakeRoute();
    for (let i = 1; i < EMPTY_COMPLETION_STREAK_LIMIT; i++) {
      recordRetryableFailure(route, emptyLengthErr(route), newFallbackState());
    }
    // A plain 429 takes the cooldown ladder — and breaks the streak.
    recordRetryableFailure(route, Object.assign(new Error('429 Too Many Requests'), { status: 429 }), newFallbackState());
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    for (let i = 1; i < EMPTY_COMPLETION_STREAK_LIMIT; i++) {
      expect(recordRetryableFailure(route, emptyLengthErr(route), newFallbackState())).toBe(true);
    }
    expect(cooldownFor(route)).toBeUndefined();
  });

  it('format violations (skipModelForRequest) stay exempt and never accrue', () => {
    const route = fakeRoute();
    const formatErr = () => Object.assign(
      new Error(`${route.displayName} ignored response_format (returned non-JSON despite json_schema)`),
      { skipBench: true, skipModelForRequest: true },
    );
    for (let i = 0; i < EMPTY_COMPLETION_STREAK_LIMIT * 2; i++) {
      expect(recordRetryableFailure(route, formatErr(), newFallbackState())).toBe(true);
    }
    // …and they did not pre-charge the empty-completion streak either.
    expect(recordRetryableFailure(route, emptyLengthErr(route), newFallbackState())).toBe(true);
    expect(cooldownFor(route)).toBeUndefined();
  });

  it('an over-the-limit empty completion counts toward the breaker', async () => {
    const route = fakeRoute();
    const onExhausted = vi.fn();
    const dispatch = vi.fn(async () => { throw emptyLengthErr(route); });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, breakerLimit: 2, route: () => route, dispatch, onExhausted }));

    // The first LIMIT-1 failures are exempt (invisible to the breaker); the
    // next two count and trip the 2-limit breaker.
    expect(dispatch).toHaveBeenCalledTimes(EMPTY_COMPLETION_STREAK_LIMIT - 1 + 2);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0][0].status).toBe(503);
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
  it('always allows one failover hop, then stops and reports timedOut (#751)', async () => {
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

    // Attempt 0 alone consumed the budget, but attempt 1 still starts — a
    // slow-failing model must never make failover structurally impossible.
    // Attempt 2 is where the spent budget stops the chain.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    const [body, info] = onExhausted.mock.calls[0];
    expect(info.timedOut).toBe(true);
    expect(body.message).toContain('retry time budget');
    expect(info.attempts).toHaveLength(2);
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

describe('runFallbackLoop: circuit-breaker guardrail (max_consecutive_upstream_fails)', () => {
  const retryable429 = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });

  it('is off by default: a doomed chain still runs to the attempt cap', async () => {
    const onExhausted = vi.fn();
    const dispatch = vi.fn(async () => { throw retryable429(); });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 5, dispatch, onExhausted }));

    expect(dispatch).toHaveBeenCalledTimes(5);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0][0].status).toBe(429); // ordinary exhaustion, no breaker
  });

  it('trips after N consecutive retryable failures and renders a 503 with the trail', async () => {
    const onExhausted = vi.fn();
    const dispatch = vi.fn(async () => { throw retryable429(); });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, breakerLimit: 3, dispatch, onExhausted }));

    expect(dispatch).toHaveBeenCalledTimes(3); // stopped at the limit, not the cap
    expect(onExhausted).toHaveBeenCalledTimes(1);
    const [body, info] = onExhausted.mock.calls[0];
    expect(body.kind).toBe('unavailable');
    expect(body.status).toBe(503);
    expect(body.type).toBe('service_unavailable');
    expect(body.message).toContain('circuit-breaker');
    expect(body.message).toContain('3 consecutive upstream failures');
    expect(body.message).toContain('Attempt trail:');
    expect(info.attempts).toHaveLength(3);
    expect(info.timedOut).toBe(false);
  });

  it('auth failures count toward the breaker, and an all-auth trip keeps the 502 diagnosis', async () => {
    mockCheckKeyHealth.mockResolvedValue(undefined);
    const onExhausted = vi.fn();
    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, breakerLimit: 2, dispatch, onExhausted }));

    expect(dispatch).toHaveBeenCalledTimes(2); // breaker stopped the rotation
    const [body, info] = onExhausted.mock.calls[0];
    expect(body.kind).toBe('auth'); // the more specific all-auth body wins over the breaker body
    expect(body.status).toBe(502);
    expect(info.attempts).toHaveLength(2);
  });

  it('skipBench failures (format ignored, hidden reasoning) never trip the breaker', async () => {
    // Three prose answers to a json_schema request say nothing about pool
    // health — candidate four must still get its shot. (#511 x #516)
    const onExhausted = vi.fn();
    let calls = 0;
    const dispatch = vi.fn(async () => {
      calls += 1;
      if (calls <= 3) {
        throw Object.assign(
          new Error(`Fake ${calls} ignored response_format (returned non-JSON despite json_schema)`),
          { skipBench: true },
        );
      }
      return 'done' as const;
    });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, breakerLimit: 3, dispatch, onExhausted }));

    expect(dispatch).toHaveBeenCalledTimes(4); // 3 skipBench failures did not trip the 3-limit breaker
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('a breaker trip after client disconnect stops the chain without rendering', async () => {
    const onExhausted = vi.fn();
    let gone = false;
    const dispatch = vi.fn(async () => {
      gone = true; // client hangs up during the (only) attempt
      throw retryable429();
    });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, breakerLimit: 1, clientGone: () => gone, dispatch, onExhausted }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled(); // no body to a dead socket
  });

  it('a success below the limit ends the request normally (breaker untouched)', async () => {
    const onExhausted = vi.fn();
    let calls = 0;
    const dispatch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw retryable429();
      return 'done' as const;
    });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, breakerLimit: 3, dispatch, onExhausted }));

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(onExhausted).not.toHaveBeenCalled();
  });
});

describe('isProviderLevelError (#788: the PROVIDER is sick, not this key)', () => {
  it('flags what only a sick provider produces: a 5xx, a timeout, a dead socket', () => {
    expect(isProviderLevelError(Object.assign(new Error('Bad Gateway'), { status: 502 }))).toBe(true);
    expect(isProviderLevelError(Object.assign(new Error('Groq API error 503: Service Unavailable'), { status: 503 }))).toBe(true);
    expect(isProviderLevelError(Object.assign(new Error('Internal Server Error'), { status: 500 }))).toBe(true);
    // Transport-level failures carry no HTTP status at all.
    expect(isProviderLevelError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
    expect(isProviderLevelError(new Error('read ECONNRESET'))).toBe(true);
    expect(isProviderLevelError(new Error('fetch failed'))).toBe(true);
    expect(isProviderLevelError(new Error('The operation was aborted (groq, chat, 120s)'))).toBe(true);
    expect(isProviderLevelError(new Error('Fake stream stalled: no data for 90000ms (timeout)'))).toBe(true);
    // A DEGRADED deployment is provider health wearing a 400 (#522).
    expect(isProviderLevelError(Object.assign(new Error("Function id 'x': DEGRADED function cannot be invoked"), { status: 400 }))).toBe(true);
  });

  it('does not misfire on digits or wording that merely LOOK like a 5xx', () => {
    // The whole point of the structured-status rule: these all carry '500'/'503'
    // /'unavailable' in their text, and condemning the platform on any of them
    // would strand every healthy key and model behind a sick-looking sentence.
    expect(isProviderLevelError(Object.assign(new Error('Request took 5003ms'), { status: 400 }))).toBe(false);
    expect(isProviderLevelError(Object.assign(new Error("API error 400: This model's maximum context length is 8192 tokens. However, your messages resulted in 5000 tokens"), { status: 400 }))).toBe(false);
    expect(isProviderLevelError(Object.assign(new Error('API error 429: quota of 5000 requests per day reached'), { status: 429 }))).toBe(false);
    expect(isProviderLevelError(Object.assign(new Error('API error 403: qwen3-coder-480b is unavailable on your key\'s tier'), { status: 403 }))).toBe(false);
  });

  it('leaves key-scoped failures alone so a dead key still rotates to a sibling', () => {
    expect(isProviderLevelError(Object.assign(new Error('Invalid API Key'), { status: 401 }))).toBe(false);
    expect(isProviderLevelError(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))).toBe(false);
    expect(isProviderLevelError(Object.assign(new Error('Payment required'), { status: 402 }))).toBe(false);
    // A vanished client says nothing about provider health.
    expect(isProviderLevelError(newClientAbortError())).toBe(false);
  });

  it('never condemns a platform for MODEL behavior, however the message reads', () => {
    // These messages quote caller- and model-supplied text: a tool called
    // `set_timeout`, or an Ajv complaint about the instance path `/timeout`,
    // puts a timeout marker in the sentence without a timeout having happened.
    // `skipModelForRequest` is the structured truth and outranks the text.
    expect(isProviderLevelError(invalidToolArgumentsError(
      'alpha alpha-big',
      ['set_timeout: /timeout must be number'],
    ))).toBe(false);
    expect(isProviderLevelError(invalidToolArgumentsError(
      'alpha alpha-big',
      ['run_query: /mode must be equal to one of the allowed values (degraded)'],
    ))).toBe(false);
    expect(isProviderLevelError(Object.assign(
      new Error('alpha alpha-big ignored response_format (returned non-JSON despite json_object)'),
      { skipBench: true, skipModelForRequest: true },
    ))).toBe(false);
  });
});

describe('runFallbackLoop: a provider-level failure skips the whole platform (#788)', () => {
  // A miniature routeRequest: walk a fixed candidate list in order and return
  // the first one this request has not ruled out, applying the same three gates
  // the real router applies (skipPlatforms, skipModels, skipKeys).
  const CANDIDATES = [
    { platform: 'alpha', modelId: 'alpha-big', modelDbId: 788_001, keyId: 78_801 },
    { platform: 'alpha', modelId: 'alpha-big', modelDbId: 788_001, keyId: 78_802 },
    { platform: 'alpha', modelId: 'alpha-small', modelDbId: 788_002, keyId: 78_801 },
    { platform: 'beta', modelId: 'beta-one', modelDbId: 788_003, keyId: 78_803 },
  ];
  const miniRouter = (state: FallbackState) => () => {
    const pick = CANDIDATES.find(c =>
      !state.skipPlatforms.has(c.platform)
      && !state.skipModels.has(c.modelDbId)
      && !state.skipKeys.has(`${c.platform}:${c.modelId}:${c.keyId}`));
    if (!pick) throw Object.assign(new Error('all candidates exhausted'), { status: 429, diagnostics: [] });
    return fakeRoute(pick);
  };
  const platformsTried = (dispatch: ReturnType<typeof vi.fn>): string[] =>
    dispatch.mock.calls.map(call => (call[0] as RouteResult).platform);

  it('a 503 on alpha key1 rules out alpha entirely — every key AND every model', async () => {
    const state = newFallbackState();
    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error('Alpha API error 503: Service Unavailable'), { status: 503 });
    });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, state, route: miniRouter(state), dispatch }));

    // Two hops, not four: alpha's sibling key and its second model are skipped
    // wholesale, so failover spends its budget on the NEXT provider.
    expect(platformsTried(dispatch)).toEqual(['alpha', 'beta']);
    expect(state.skipPlatforms.has('alpha')).toBe(true);
  });

  it('a 401 on alpha key1 still rotates to alpha key2 (key-scoped, not provider-scoped)', async () => {
    const state = newFallbackState();
    const dispatch = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Invalid API Key'), { status: 401 }))
      .mockResolvedValueOnce('done');

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, state, route: miniRouter(state), dispatch }));

    expect(dispatch).toHaveBeenCalledTimes(2);
    const second = dispatch.mock.calls[1][0] as RouteResult;
    expect(second.platform).toBe('alpha');
    expect(second.keyId).toBe(78_802);
    expect(state.skipPlatforms.size).toBe(0);
  });

  it('a plain 429 also stays key-scoped', async () => {
    const state = newFallbackState();
    const dispatch = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))
      .mockResolvedValueOnce('done');

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, state, route: miniRouter(state), dispatch }));

    expect((dispatch.mock.calls[1][0] as RouteResult).platform).toBe('alpha');
    expect(state.skipPlatforms.size).toBe(0);
  });

  it('invalid tool arguments rule out the MODEL, never the platform', async () => {
    // The provider served the turn perfectly; the model wrote a bad call. The
    // sibling key would write the same one (skipModelForRequest), but alpha's
    // OTHER model is still a fine next hop — skipping the platform here would
    // strand it, and the tool name in the message carries a timeout marker
    // precisely to prove the text does not drive the decision.
    const state = newFallbackState();
    const dispatch = vi.fn()
      .mockRejectedValueOnce(invalidToolArgumentsError('alpha alpha-big', ['set_timeout: /timeout must be number']))
      .mockResolvedValueOnce('done');

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, state, route: miniRouter(state), dispatch }));

    expect(dispatch).toHaveBeenCalledTimes(2);
    const second = dispatch.mock.calls[1][0] as RouteResult;
    expect(second.platform).toBe('alpha');
    expect(second.modelId).toBe('alpha-small');   // not the sibling key of alpha-big
    expect(state.skipPlatforms.size).toBe(0);
    expect(state.skipModels.has(788_001)).toBe(true);
  });

  it('a timeout with no HTTP status rules the platform out too', async () => {
    const state = newFallbackState();
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error('The operation was aborted (alpha, chat, 120s)'))
      .mockResolvedValueOnce('done');

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, state, route: miniRouter(state), dispatch }));

    expect((dispatch.mock.calls[1][0] as RouteResult).platform).toBe('beta');
    expect(state.skipPlatforms.has('alpha')).toBe(true);
  });
});

describe('runFallbackLoop: client disconnect + attempt log', () => {
  const retryable = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });

  it('stops starting retries once the client is gone, without rendering exhaustion', async () => {
    const onExhausted = vi.fn();
    let gone = false;
    const dispatch = vi.fn(async () => { gone = true; throw retryable(); });

    await runFallbackLoop(hooksSkeleton({
      maxRetries: 20,
      clientGone: () => gone,
      dispatch,
      onExhausted,
    }));

    expect(dispatch).toHaveBeenCalledTimes(1); // first attempt ran, no retry started
    expect(onExhausted).not.toHaveBeenCalled(); // nothing to render to a dead socket
  });

  it('a connected client is unaffected (clientGone false)', async () => {
    const onExhausted = vi.fn();
    const dispatch = vi.fn(async () => { throw retryable(); });
    await runFallbackLoop(hooksSkeleton({ maxRetries: 3, clientGone: () => false, dispatch, onExhausted }));
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('records failed attempts into the caller-supplied attemptLog', async () => {
    const attemptLog: AttemptRecord[] = [];
    let calls = 0;
    const dispatch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw retryable();
      return 'done' as const;
    });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 20, attemptLog, dispatch }));

    expect(attemptLog).toHaveLength(2); // the two failures, not the success
    expect(attemptLog[0].errorClass).toBe('rate_limited');
  });
});

// The diagnostics line used to live in each surface's onRoutingExhausted hook,
// and only routes/proxy.ts ever implemented it — so an opaque routing_error on
// /v1/messages, /v1/responses or an inbound wire recorded nothing about WHY the
// pool was empty. It belongs to the loop: these tests pin it there, for every
// surface, including one that supplies no identity at all.
describe('runFallbackLoop: routing-exhaustion diagnostics belong to the loop', () => {
  const routeError = (diagnostics: string[]) =>
    Object.assign(new Error('all candidates exhausted'), { status: 429, diagnostics });

  const warnedLine = (warn: ReturnType<typeof vi.spyOn>): string | undefined =>
    warn.mock.calls.map(c => String(c[0])).find(l => l.includes('routing exhausted'));

  it('logs the router per-candidate disposition when no upstream was tried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runFallbackLoop(hooksSkeleton({
        logIdentity: { surface: 'anthropic messages', requestId: 'abcdef12-3456-7890', requestedModel: 'claude-x' },
        route: () => { throw routeError(['glm-4.7 @zai: cooldown 42s', 'llama @groq: rpd 0 left']); },
      }));
      const line = warnedLine(warn);
      expect(line).toBeDefined();
      expect(line).toContain('anthropic messages');
      expect(line).toContain('req=abcdef');           // hyphens stripped, 6 chars
      expect(line).toContain('requested=claude-x');
      expect(line).toContain('candidates=2');
      expect(line).toContain('glm-4.7 @zai: cooldown 42s');
      expect(line).toContain('llama @groq: rpd 0 left');
    } finally {
      warn.mockRestore();
    }
  });

  it('still fires for a surface that supplies no logIdentity', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runFallbackLoop(hooksSkeleton({
        route: () => { throw routeError(['solo @fake: no usable key']); },
      }));
      const line = warnedLine(warn);
      expect(line).toBeDefined();
      expect(line).toContain('unidentified surface');
      expect(line).toContain('candidates=1');
      expect(line).toContain('solo @fake: no usable key');
    } finally {
      warn.mockRestore();
    }
  });

  it('handles a RouteError carrying no diagnostics at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runFallbackLoop(hooksSkeleton({
        logIdentity: { surface: 'inbound chat' },
        route: () => { throw Object.assign(new Error('nothing routable'), { status: 429 }); },
      }));
      const line = warnedLine(warn);
      expect(line).toBeDefined();
      expect(line).toContain('inbound chat');
      expect(line).toContain('candidates=0');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when attempts already ran — the attempt trail explains those', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let call = 0;
      await runFallbackLoop(hooksSkeleton({
        logIdentity: { surface: 'chat completions' },
        route: () => {
          if (call++ === 0) return fakeRoute();
          throw routeError(['everything @fake: cooldown']);
        },
        dispatch: async () => { throw Object.assign(new Error('Too Many Requests'), { status: 429 }); },
      }));
      expect(warnedLine(warn)).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
