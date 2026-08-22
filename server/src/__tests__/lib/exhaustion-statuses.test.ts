import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Honest exhaustion statuses (P1): when the fallback ladder exhausts every
// candidate, the terminal status must say WHY it failed and when to retry —
// 413 when every attempt died on a context/size rejection, 429 + retryAtMs +
// Retry-After when every candidate is unavailable until a known time, 404 when
// the model is gone everywhere, 503 when nothing is configured at all, and 502
// (never 500, never a lying 429) for mixed/other upstream failures.

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({ checkKeyHealth: mockCheckKeyHealth, markKeyHealthyFromRequest: vi.fn() }));

import { initDb, getDb } from '../../db/index.js';
import {
  runFallbackLoop,
  newFallbackState,
  exhaustedRetryError,
  routingExhaustionBody,
  exhaustionErrorPayload,
  setExhaustionHeaders,
  classifyAttemptError,
  type AttemptRecord,
  type AttemptErrorClass,
  type FallbackHooks,
} from '../../lib/fallback-loop.js';
import { isContextTooLargeError } from '../../lib/error-classify.js';
import { setCooldown } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

let keySeq = 96_000;
function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: 'fake-model', modelDbId: 962000 + n, apiKey: 'k',
    keyId: n, platform: 'fake', displayName: 'Fake Model',
    rpdLimit: null, tpdLimit: null,
    ...overrides,
  };
}

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

const record = (classes: AttemptErrorClass[]): AttemptRecord[] =>
  classes.map((errorClass, i) => ({ platform: 'fake', modelId: `m${i}`, keyOrdinal: i + 1, errorClass }));

// Fake key-shaped fixture built at runtime: an obvious prefix + low-entropy filler.
const FAKE_KEY = 'sk-test-' + 'a'.repeat(20);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  mockCheckKeyHealth.mockReset();
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
});

// ── isContextTooLargeError: real provider error shapes ───────────────────────

describe('isContextTooLargeError', () => {
  it('flags OpenAI-compat context_length_exceeded shapes (message and code)', () => {
    expect(isContextTooLargeError(Object.assign(
      new Error("OpenAI-compat API error 400: This model's maximum context length is 8192 tokens. However, your messages resulted in 10012 tokens. Please reduce the length of the messages."),
      { status: 400 },
    ))).toBe(true);
    expect(isContextTooLargeError(Object.assign(new Error('Bad request'), { status: 400, code: 'context_length_exceeded' }))).toBe(true);
    expect(isContextTooLargeError(new Error("400 {\"error\":{\"message\":\"...\",\"code\":\"context_length_exceeded\"}}"))).toBe(true);
  });

  it('flags Anthropic-style prompt-too-long shapes', () => {
    expect(isContextTooLargeError(Object.assign(
      new Error('Anthropic API error 400: prompt is too long: 210021 tokens > 200000 maximum'),
      { status: 400 },
    ))).toBe(true);
    expect(isContextTooLargeError(new Error('Input is too long for requested model.'))).toBe(true);
  });

  it('flags Google/Gemini token-limit shapes', () => {
    expect(isContextTooLargeError(Object.assign(
      new Error('Google API error 400: The input token count (1194286) exceeds the maximum number of tokens allowed (1048576).'),
      { status: 400 },
    ))).toBe(true);
    expect(isContextTooLargeError(new Error('request exceeds the maximum number of tokens'))).toBe(true);
  });

  it('flags Zhipu AI prompt-length 400s (error 1261: "Prompt exceeds max length")', () => {
    // #873: Zhipu returns HTTP 400 with "Prompt exceeds max length" for an
    // over-long context. Its wording matches none of the OpenAI/Anthropic/Google
    // markers, so it was mis-bucketed as provider_bad_request instead of
    // context_too_large.
    expect(isContextTooLargeError(Object.assign(
      new Error('Zhipu API error 400: Prompt exceeds max length. Please shorten the prompt or set a longer context length.'),
      { status: 400 },
    ))).toBe(true);
    expect(classifyAttemptError(Object.assign(
      new Error('Zhipu API error 400: Prompt exceeds max length.'),
      { status: 400 },
    ))).toBe('context_too_large');
  });

  it('flags literal HTTP 413s, including Groq TPM-ceiling 413s (Requested > Limit can never fit)', () => {
    expect(isContextTooLargeError(Object.assign(
      new Error('Groq API error 413: Request too large for model `llama-3.3-70b-versatile` in organization `org_x` on tokens per minute (TPM): Limit 30000, Requested 33476'),
      { status: 413 },
    ))).toBe(true);
    expect(isContextTooLargeError(new Error('API error 413: Payload Too Large'))).toBe(true);
    expect(isContextTooLargeError(new Error('Request entity too large'))).toBe(true);
    expect(isContextTooLargeError(new Error('Cloudflare API error 413: content too large'))).toBe(true);
  });

  it('flags Zhipu / Z.ai "Prompt exceeds max length" 400s (bare wording, no code field) (#873)', () => {
    expect(isContextTooLargeError(Object.assign(
      new Error('Zhipu API error 400: Prompt exceeds max length'),
      { status: 400 },
    ))).toBe(true);
    expect(isContextTooLargeError(new Error('API error 400: prompt exceeds max length'))).toBe(true);
  });

  it('does not flag rate limits, ordinary 400s, or upstream errors', () => {
    expect(isContextTooLargeError(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))).toBe(false);
    expect(isContextTooLargeError(Object.assign(new Error('Groq API error 429: Rate limit reached on requests per day (RPD): Limit 1000'), { status: 429 }))).toBe(false);
    expect(isContextTooLargeError(Object.assign(new Error('Google API error 400: Invalid JSON payload received. Unknown name "x"'), { status: 400 }))).toBe(false);
    expect(isContextTooLargeError(Object.assign(new Error('Internal server error'), { status: 500 }))).toBe(false);
    expect(isContextTooLargeError(new Error('you have used up your daily free allocation of 10,000 neurons'))).toBe(false);
  });

  it('classifyAttemptError buckets context errors ahead of provider_bad_request', () => {
    // The OpenAI-compat shape contains "API error 400", which the generic
    // bad-request rule would otherwise swallow.
    expect(classifyAttemptError(Object.assign(
      new Error("OpenAI-compat API error 400: This model's maximum context length is 8192 tokens."),
      { status: 400 },
    ))).toBe('context_too_large');
    expect(classifyAttemptError(Object.assign(
      new Error('Zhipu API error 400: Prompt exceeds max length'),
      { status: 400 },
    ))).toBe('context_too_large');
    expect(classifyAttemptError(Object.assign(new Error('API error 413: Payload Too Large'), { status: 413 }))).toBe('context_too_large');
  });
});

// ── exhaustedRetryError: failure-kind → terminal-status taxonomy ─────────────

describe('exhaustedRetryError honest terminal statuses', () => {
  it('all attempts context-too-large → 413 invalid_request_error / context_length_exceeded', () => {
    const body = exhaustedRetryError(new Error('prompt is too long: 210000 tokens > 200000 maximum'), 20, {
      attempts: record(['context_too_large', 'context_too_large', 'context_too_large']),
    });
    expect(body.status).toBe(413);
    expect(body.kind).toBe('context_too_large');
    expect(body.type).toBe('invalid_request_error');
    expect(body.code).toBe('context_length_exceeded');
    expect(body.retryAtMs).toBeUndefined();
    expect(body.message).toContain('too large');
    expect(body.message).toContain('Attempt trail:');
  });

  it('the all-context 413 wins even when the last error is shaped like a generic provider 400', () => {
    // "API error 400" would match isProviderBadRequestError; the aggregate
    // unanimity must outrank the shape of whichever error came last.
    const lastError = Object.assign(
      new Error("OpenAI-compat API error 400: This model's maximum context length is 8192 tokens."),
      { status: 400 },
    );
    const body = exhaustedRetryError(lastError, 20, { attempts: record(['context_too_large', 'context_too_large']) });
    expect(body.status).toBe(413);
    expect(body.code).toBe('context_length_exceeded');
  });

  it('all attempts model-not-found → 404 model_not_found (no 410: the catalog keeps no removal tombstones)', () => {
    const body = exhaustedRetryError(Object.assign(new Error('no endpoints found'), { status: 404 }), 20, {
      attempts: record(['model_not_found', 'model_not_found']),
    });
    expect(body.status).toBe(404);
    expect(body.kind).toBe('model_not_found');
    expect(body.type).toBe('invalid_request_error');
    expect(body.code).toBe('model_not_found');
  });

  it('every candidate unavailable-until-known-time → 429 with retryAtMs from the soonest cooldown', () => {
    const before = Date.now();
    setCooldown('fake', 'benched-model', ++keySeq, 90_000);
    const body = exhaustedRetryError(Object.assign(new Error('429 Too Many Requests'), { status: 429 }), 20, {
      attempts: record(['rate_limited', 'daily_quota_exhausted', 'out_of_credits', 'forbidden']),
    });
    expect(body.status).toBe(429);
    expect(body.kind).toBe('rate_limit');
    expect(body.type).toBe('rate_limit_error');
    expect(body.code).toBe('rate_limit_exceeded');
    expect(body.retryAtMs).toBeGreaterThanOrEqual(before + 80_000);
    expect(body.retryAtMs).toBeLessThanOrEqual(Date.now() + 95_000);
  });

  it('the 429 omits retryAtMs when nothing is cooling down (no invented numbers)', () => {
    const body = exhaustedRetryError(new Error('429 Too Many Requests'), 20, {
      attempts: record(['rate_limited']),
    });
    expect(body.status).toBe(429);
    expect(body.retryAtMs).toBeUndefined();
  });

  it('mixed rate-limit + upstream-error → 502 (waiting is not a promise), never 500', () => {
    setCooldown('fake', 'benched-model', ++keySeq, 90_000); // a cooldown exists, but the mix forbids the 429
    const body = exhaustedRetryError(Object.assign(new Error('Bad Gateway'), { status: 502 }), 20, {
      attempts: record(['rate_limited', 'upstream_error']),
    });
    expect(body.status).toBe(502);
    expect(body.kind).toBe('upstream');
    expect(body.type).toBe('provider_error');
    expect(body.code).toBe('upstream_failed');
    expect(body.retryAtMs).toBeUndefined();
    expect(body.message).toContain('provider-side failure');
  });

  it('all upstream/network failures → 502 upstream_failed (upstream failed, not our bug)', () => {
    for (const classes of [['upstream_error', 'upstream_error'], ['timeout', 'upstream_error'], ['timeout', 'error']] as AttemptErrorClass[][]) {
      const body = exhaustedRetryError(Object.assign(new Error('fetch failed'), {}), 20, { attempts: record(classes) });
      expect(body.status).toBe(502);
      expect(body.code).toBe('upstream_failed');
    }
  });

  it('mixed context + rate-limit is neither a 413 nor a 429: falls through to 502', () => {
    const body = exhaustedRetryError(Object.assign(new Error('429'), { status: 429 }), 20, {
      attempts: record(['context_too_large', 'rate_limited']),
    });
    expect(body.status).toBe(502);
  });

  it('precedence: all-auth 502 and the aggregate 413 both outrank the circuit-breaker 503', () => {
    const auth = exhaustedRetryError(new Error('401'), 20, { attempts: record(['auth', 'auth']), breakerFails: 2 });
    expect(auth.status).toBe(502);
    expect(auth.kind).toBe('auth');
    expect(auth.code).toBe('provider_authentication_failed');

    const ctx = exhaustedRetryError(new Error('prompt is too long: 9 tokens > 8 maximum'), 20, {
      attempts: record(['context_too_large', 'context_too_large']),
      breakerFails: 2,
    });
    expect(ctx.status).toBe(413);
  });

  it('precedence: a breaker stop over a MIXED pool still renders the 503 breaker body', () => {
    const body = exhaustedRetryError(Object.assign(new Error('Bad Gateway'), { status: 502 }), 20, {
      attempts: record(['rate_limited', 'upstream_error']),
      breakerFails: 2,
    });
    expect(body.status).toBe(503);
    expect(body.code).toBe('upstream_unhealthy');
    expect(body.message).toContain('circuit-breaker');
  });

  it('legacy zero-attempt shape keeps the 429 contract', () => {
    const body = exhaustedRetryError(new Error('429 Too Many Requests'), 20);
    expect(body.status).toBe(429);
    expect(body.type).toBe('rate_limit_error');
  });
});

// ── routingExhaustionBody: zero attempts ran ─────────────────────────────────

describe('routingExhaustionBody (router gave up before any upstream was tried)', () => {
  it('empty chain / no diagnostics → 503 no_providers_configured', () => {
    const body = routingExhaustionBody({ message: 'All models exhausted.', status: 429, diagnostics: [] });
    expect(body.status).toBe(503);
    expect(body.type).toBe('service_unavailable');
    expect(body.code).toBe('no_providers_configured');
  });

  it('every candidate lacks a provider/usable key → 503 no_providers_configured', () => {
    const body = routingExhaustionBody({
      message: 'All models exhausted: 2 routes checked.',
      status: 429,
      diagnostics: [
        'openai/gpt-4o-mini: no enabled+healthy key for platform',
        'weird/x: no provider registered',
      ],
    });
    expect(body.status).toBe(503);
    expect(body.code).toBe('no_providers_configured');
  });

  it('every candidate rate-limited/on cooldown → 429 with retryAtMs', () => {
    const before = Date.now();
    setCooldown('fake', 'routing-benched', ++keySeq, 120_000);
    const body = routingExhaustionBody({
      message: 'All models exhausted: 2 routes checked.',
      status: 429,
      diagnostics: [
        'groq/llama-3.3-70b: 2 key(s) — cooldown:2',
        'google/gemini-2.0-flash: 1 key(s) — rpm/rpd-limit:1',
      ],
    });
    expect(body.status).toBe(429);
    expect(body.code).toBe('rate_limit_exceeded');
    expect(body.retryAtMs).toBeGreaterThanOrEqual(before + 110_000);
  });

  it('rate-limited candidates mixed with unconfigured ones still → 429 (the pool recovers by itself)', () => {
    const body = routingExhaustionBody({
      message: 'All models exhausted.',
      status: 429,
      diagnostics: [
        'groq/llama-3.3-70b: 1 key(s) — cooldown:1',
        'weird/x: no provider registered',
      ],
    });
    expect(body.status).toBe(429);
    expect(body.code).toBe('rate_limit_exceeded');
  });

  it('every candidate too small for the request → 413 context_length_exceeded', () => {
    const body = routingExhaustionBody({
      message: 'All models exhausted: 2 routes checked (2 prompt too large for the model).',
      status: 429,
      diagnostics: [
        'groq/llama-3.1-8b: context 8192 < estimated 50000',
        'groq/gpt-oss-120b: tpm_limit 8000 < estimated 50000',
      ],
    });
    expect(body.status).toBe(413);
    expect(body.code).toBe('context_length_exceeded');
    expect(body.type).toBe('invalid_request_error');
  });

  it('capability-filtered candidates keep the router status with a routing_exhausted code', () => {
    const body = routingExhaustionBody({
      message: 'All models exhausted.',
      status: 429,
      diagnostics: [
        'fake/text-only: no vision support',
        'groq/llama-3.3-70b: 1 key(s) — cooldown:1',
      ],
    });
    expect(body.status).toBe(429);
    expect(body.code).toBe('routing_exhausted');
  });
});

// ── Wire helpers: OpenAI error payload + Retry-After header ──────────────────

describe('exhaustionErrorPayload / setExhaustionHeaders', () => {
  it('the payload carries type/code/retryAtMs and omits absent fields', () => {
    const full = exhaustionErrorPayload({
      status: 429, kind: 'rate_limit', type: 'rate_limit_error', code: 'rate_limit_exceeded',
      retryAtMs: 1234, message: 'm',
    });
    expect(full).toEqual({ message: 'm', type: 'rate_limit_error', code: 'rate_limit_exceeded', retryAtMs: 1234 });

    const bare = exhaustionErrorPayload({ status: 502, kind: 'upstream', type: 'provider_error', message: 'm' });
    expect(bare).toEqual({ message: 'm', type: 'provider_error' });
    expect('retryAtMs' in bare).toBe(false);
  });

  it('Retry-After is ceil((retryAtMs - now) / 1000) seconds', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (n: string, v: string) => { headers[n] = v; } };
    const now = Date.now();
    setExhaustionHeaders(res, {
      status: 429, kind: 'rate_limit', type: 'rate_limit_error', message: 'm',
      retryAtMs: now + 61_500,
    }, now);
    expect(headers['Retry-After']).toBe('62');
  });

  it('no Retry-After without a concrete retry time; an elapsed one clamps to 0', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (n: string, v: string) => { headers[n] = v; } };
    setExhaustionHeaders(res, { status: 502, kind: 'upstream', type: 'provider_error', message: 'm' });
    expect(headers['Retry-After']).toBeUndefined();
    setExhaustionHeaders(res, { status: 429, kind: 'rate_limit', type: 'rate_limit_error', message: 'm', retryAtMs: Date.now() - 5_000 });
    expect(headers['Retry-After']).toBe('0');
  });
});

// ── End-to-end through the shared loop ───────────────────────────────────────

describe('runFallbackLoop renders honest exhaustion bodies', () => {
  it('an all-rate-limited chain exhausts into a 429 whose retryAtMs comes from the cooldowns the loop itself set', async () => {
    const before = Date.now();
    const onExhausted = vi.fn();
    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    });

    await runFallbackLoop(hooksSkeleton({
      maxRetries: 3,
      route: () => fakeRoute({ apiKey: FAKE_KEY }),
      dispatch,
      onExhausted,
    }));

    expect(onExhausted).toHaveBeenCalledTimes(1);
    const [body] = onExhausted.mock.calls[0];
    expect(body.status).toBe(429);
    expect(body.code).toBe('rate_limit_exceeded');
    // recordRetryableFailure benched each failed key, so the soonest expiry is real.
    expect(body.retryAtMs).toBeGreaterThan(before);
  });

  it('a rate-limit + upstream-5xx mix exhausts into a 502, not a lying 429', async () => {
    const onExhausted = vi.fn();
    let call = 0;
    const dispatch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
      throw Object.assign(new Error('Bad Gateway'), { status: 502 });
    });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 3, dispatch, onExhausted }));

    const [body] = onExhausted.mock.calls[0];
    expect(body.status).toBe(502);
    expect(body.kind).toBe('upstream');
    expect(body.code).toBe('upstream_failed');
  });

  it('an all-context-too-large chain exhausts into a 413', async () => {
    const onExhausted = vi.fn();
    const dispatch = vi.fn(async () => {
      throw Object.assign(
        new Error("OpenAI-compat API error 400: This model's maximum context length is 8192 tokens."),
        { status: 400 },
      );
    });

    await runFallbackLoop(hooksSkeleton({ maxRetries: 2, dispatch, onExhausted }));

    const [body] = onExhausted.mock.calls[0];
    expect(body.status).toBe(413);
    expect(body.code).toBe('context_length_exceeded');
  });

  it('routing exhaustion with zero attempts hands the surface a ready 503 body when nothing is configured', async () => {
    const onRoutingExhausted = vi.fn();
    await runFallbackLoop(hooksSkeleton({
      route: () => {
        throw Object.assign(new Error('All models exhausted.'), {
          status: 429,
          diagnostics: ['openai/gpt-4o-mini: no enabled+healthy key for platform'],
        });
      },
      onRoutingExhausted,
    }));

    expect(onRoutingExhausted).toHaveBeenCalledTimes(1);
    const [lastError, , exhaustion] = onRoutingExhausted.mock.calls[0];
    expect(lastError).toBeNull();
    expect(exhaustion.status).toBe(503);
    expect(exhaustion.code).toBe('no_providers_configured');
  });
});
