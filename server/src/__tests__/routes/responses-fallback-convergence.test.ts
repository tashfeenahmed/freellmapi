import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Characterization tests for the drifts the shared fallback loop
// (lib/fallback-loop.ts) converged on the /v1/responses surface:
//   - drift #2: a provider Retry-After is now honored, and a 403 model-not-on-tier
//     is day-benched (MODEL_FORBIDDEN_COOLDOWN_MS), instead of the old flat 90s
//     transient cooldown that fell through here before.
//   - drift #1: the SSE skeleton commits on the first MEANINGFUL content, not the
//     first raw chunk — so a role-only chunk followed by an error fails over
//     invisibly on the same connection instead of dead-ending as response.failed.

// Mock only routeRequest so we can script the provider + exhaustion precisely;
// the rest of the router (recordRateLimitHit / hasOtherUsableKey) and the whole
// ratelimit module (setCooldown persistence) stay real.
const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeRoute(provider: any) {
  return {
    provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1,
    platform: 'fake', displayName: 'Fake Model', rpdLimit: null, tpdLimit: null,
  };
}

function throwingProvider(err: any) {
  return {
    async chatCompletion() { throw err; },
    async *streamChatCompletion(): AsyncGenerator<any> { throw err; },
  };
}

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  return { status: res.status, text };
}

function cooldownExpiry(): number | null {
  const row = getDb().prepare(
    "SELECT expires_at_ms FROM rate_limit_cooldowns WHERE platform = 'fake' AND model_id = 'fake-model' AND key_id = 1",
  ).get() as { expires_at_ms: number } | undefined;
  return row?.expires_at_ms ?? null;
}

describe('/v1/responses shared-loop convergence', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    mockRouteRequest.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    getDb().prepare('DELETE FROM rate_limit_usage').run();
  });

  it('honors a provider Retry-After on the cooldown (drift #2 — was ignored on /v1/responses)', async () => {
    const retryAfterMs = 5 * 60 * 1000; // 5 minutes, well over the 90s transient floor
    const err = Object.assign(new Error('Groq API error 429: rate limit'), { status: 429, retryAfterMs });
    mockRouteRequest.mockImplementation((_estimated: number, skipKeys?: Set<string>) => {
      if (skipKeys?.size) throw Object.assign(new Error('All models exhausted'), { status: 429 });
      return fakeRoute(throwingProvider(err));
    });

    const before = Date.now();
    const { status } = await post(app, '/v1/responses', { input: 'hi', stream: false }, key);
    expect(status).toBe(429); // exhausted after the single scripted model failed over

    const expiry = cooldownExpiry();
    expect(expiry).not.toBeNull();
    const benchMs = expiry! - before;
    // Retry-After (5 min) is honored: benched well beyond the 90s transient and
    // well short of the day-long payment/forbidden bench.
    expect(benchMs).toBeGreaterThan(4 * 60 * 1000);
    expect(benchMs).toBeLessThan(10 * 60 * 1000);
  });

  it('day-benches a 403 model-not-on-tier (drift #2 — fell through to 90s transient before)', async () => {
    const err = Object.assign(new Error('GitHub Models API error 403: Model not available on your plan'), { status: 403 });
    mockRouteRequest.mockImplementation((_estimated: number, skipKeys?: Set<string>) => {
      if (skipKeys?.size) throw Object.assign(new Error('All models exhausted'), { status: 429 });
      return fakeRoute(throwingProvider(err));
    });

    const before = Date.now();
    const { status } = await post(app, '/v1/responses', { input: 'hi', stream: false }, key);
    expect(status).toBe(429);

    const expiry = cooldownExpiry();
    expect(expiry).not.toBeNull();
    // MODEL_FORBIDDEN_COOLDOWN_MS is a full day; assert at least ~23h out (would
    // have been ~90s before the convergence).
    expect(expiry! - before).toBeGreaterThan(DAY_MS - 60 * 60 * 1000);
  });

  it('streams over a role-only chunk then an error, failing over invisibly (drift #1 commit point)', async () => {
    async function* roleThenError(): AsyncGenerator<any> {
      // A role preamble is NOT meaningful content — the skeleton must stay held.
      yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
      throw Object.assign(new Error('OpenRouter API error 503: Provider returned error'), { status: 503 });
    }
    async function* good(): AsyncGenerator<any> {
      yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'recovered ' }, finish_reason: null }] };
      yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] };
    }
    const streamGood = vi.fn(good);
    mockRouteRequest
      .mockReturnValueOnce(fakeRoute({ async chatCompletion() { throw new Error('nope'); }, streamChatCompletion: roleThenError }))
      .mockReturnValueOnce(fakeRoute({ async chatCompletion() { throw new Error('nope'); }, streamChatCompletion: streamGood }));

    const { status, text } = await post(app, '/v1/responses', { input: 'hi', stream: true }, key);
    expect(status).toBe(200);
    // The pre-content failure produced no committed bytes: no response.failed,
    // the second model's answer completes the same connection.
    expect(text).not.toContain('response.failed');
    expect(text).toContain('response.completed');
    expect(text).toContain('recovered answer');
    expect(streamGood).toHaveBeenCalledTimes(1);
  });
});
