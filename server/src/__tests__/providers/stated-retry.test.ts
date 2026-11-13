import { describe, it, expect } from 'vitest';
import { parseStatedRetryMs, providerHttpError } from '../../providers/base.js';

// Not every provider uses the Retry-After header. Gemini answers a 429 with a
// google.rpc.RetryInfo in error.details[], and several OpenAI-compatible tiers
// only say it in prose. Those hints used to be thrown away, so a provider that
// told us exactly when to come back got the same heuristic cooldown ladder as
// one that said nothing.

const response = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

describe('parseStatedRetryMs — google.rpc.RetryInfo', () => {
  // The shape Gemini actually returns on a free-tier 429.
  const geminiQuotaBody = {
    error: {
      code: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generate_requests_per_model_per_day' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' },
      ],
    },
  };

  it('reads the retryDelay out of the details array', () => {
    expect(parseStatedRetryMs(geminiQuotaBody)).toBe(17_000);
  });

  it('handles a fractional protobuf duration', () => {
    expect(parseStatedRetryMs({ error: { details: [{ retryDelay: '1.5s' }] } })).toBe(1_500);
    expect(parseStatedRetryMs({ error: { details: [{ retryDelay: '0.25s' }] } })).toBe(250);
  });
});

describe('parseStatedRetryMs — other stated shapes', () => {
  it('accepts snake_case and camelCase spellings', () => {
    expect(parseStatedRetryMs({ retry_after: 30 })).toBe(30_000);
    expect(parseStatedRetryMs({ retryAfter: 30 })).toBe(30_000);
    expect(parseStatedRetryMs({ error: { retry_after_seconds: 45 } })).toBe(45_000);
  });

  it('accepts a numeric value that arrived as a string', () => {
    expect(parseStatedRetryMs({ retry_after: '30' })).toBe(30_000);
  });

  it('finds the field however deeply the provider buried it', () => {
    expect(parseStatedRetryMs({ a: { b: { c: { retryDelay: '5s' } } } })).toBe(5_000);
  });
});

describe('parseStatedRetryMs — prose', () => {
  it('reads the Groq-style sentence', () => {
    const body = { error: { message: 'Rate limit reached for model X. Please try again in 7.66s.' } };
    expect(parseStatedRetryMs(body)).toBe(7_660);
  });

  it('understands the units providers actually use', () => {
    expect(parseStatedRetryMs('please retry after 30 seconds')).toBe(30_000);
    expect(parseStatedRetryMs('try again in 2m')).toBe(120_000);
    expect(parseStatedRetryMs('try again in 1 hour')).toBe(3_600_000);
    expect(parseStatedRetryMs('try again in 500ms')).toBe(500);
  });

  it('sums compound durations the way Groq and OpenAI write them', () => {
    const body = { error: { message: 'Rate limit reached on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 1m26s. Need more requests? Upgrade to Dev Tier today' } };
    expect(parseStatedRetryMs(body)).toBe(86_000);
    expect(parseStatedRetryMs('Please try again in 7m12s.')).toBe(432_000);
    expect(parseStatedRetryMs('Please try again in 6m0.512s.')).toBe(360_512);
    expect(parseStatedRetryMs('try again in 2h3m')).toBe(7_380_000);
    expect(parseStatedRetryMs('retry after 2 minutes 30 seconds')).toBe(150_000);
  });

  it('ignores a number that is not followed by a unit', () => {
    expect(parseStatedRetryMs('please try again in 5 or so')).toBeUndefined();
  });

  it('requires an explicit retry phrase, so a stray number is never mistaken for a back-off', () => {
    expect(parseStatedRetryMs('You have used 30 seconds of compute')).toBeUndefined();
    expect(parseStatedRetryMs({ error: { message: 'model gpt-4 is 30s slower than usual' } })).toBeUndefined();
    expect(parseStatedRetryMs({ error: { message: 'Invalid API Key' } })).toBeUndefined();
  });
});

describe('parseStatedRetryMs — refusals', () => {
  it('returns undefined for nothing, and never throws', () => {
    expect(parseStatedRetryMs(undefined)).toBeUndefined();
    expect(parseStatedRetryMs(null)).toBeUndefined();
    expect(parseStatedRetryMs({})).toBeUndefined();
    expect(parseStatedRetryMs(42)).toBeUndefined();
  });

  it('survives a circular body', () => {
    const circular: any = { error: {} };
    circular.error.self = circular;
    expect(() => parseStatedRetryMs(circular)).not.toThrow();
  });

  it('does not spin on a deeply nested body', () => {
    let deep: any = { retryDelay: '5s' };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    expect(() => parseStatedRetryMs(deep)).not.toThrow();
  });

  it('clamps a hostile value to a day, like the header path', () => {
    expect(parseStatedRetryMs({ retry_after: 99_999_999_999 })).toBe(24 * 60 * 60 * 1000);
  });

  it('ignores a negative delay rather than benching into the past', () => {
    expect(parseStatedRetryMs({ retry_after: -5 })).toBeUndefined();
  });
});

describe('providerHttpError', () => {
  it('picks up a body-stated delay when there is no Retry-After header', () => {
    const err = providerHttpError(response(429), 'Google API error 429: quota', {
      error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }] },
    });

    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(17_000);
  });

  it('lets the Retry-After header win, so existing behavior is unchanged', () => {
    // Both are provider-stated; the header is the standard channel.
    const err = providerHttpError(response(429, { 'retry-after': '60' }), 'rate limited', {
      error: { details: [{ retryDelay: '17s' }] },
    });

    expect(err.retryAfterMs).toBe(60_000);
  });

  it('is unchanged when neither states a delay', () => {
    const err = providerHttpError(response(500), 'upstream boom', { error: { message: 'boom' } });

    expect(err.status).toBe(500);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('still works when no body is passed at all', () => {
    const err = providerHttpError(response(429, { 'retry-after': '5' }), 'rate limited');

    expect(err.retryAfterMs).toBe(5_000);
  });

  it('keeps only the number — the body itself is never retained', () => {
    // Nothing from the payload should be able to reach a log or the trace
    // through this object.
    const err = providerHttpError(response(429), 'rate limited', {
      error: { retryDelay: '3s', apiKey: 'sk-SECRET', message: 'quota' },
    });

    expect(err.retryAfterMs).toBe(3_000);
    expect(JSON.stringify(err)).not.toContain('SECRET');
    expect(Object.keys(err)).toEqual(expect.not.arrayContaining(['body']));
  });
});
