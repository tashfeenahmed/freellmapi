import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Issue #1239 — "All rejected": a Claude Code user's request burned its whole
// 45s failover budget on eight hops that were never going to work and was then
// told the REQUEST was invalid. The trail:
//
//   navy/gpt-5.4-mini key1: provider_bad_request; navy/gpt-5-search-api key1:
//   provider_bad_request; navy/o4-mini key1: provider_bad_request;
//   huggingface/thinkingmachines/Inkling key2: out_of_credits; navy/o3 key1:
//   provider_bad_request; huggingface/Qwen/Qwen3-VL-235B-A22B-Instruct key2:
//   out_of_credits; huggingface/moonshotai/Kimi-K3 key2: out_of_credits;
//   navy/o3-mini key1: provider_bad_request.
//   Last error: NavyAI API error 400: The model 'o3-mini' does not exist or is
//   not supported for chat completions.
//
// Three router defects, each covered below:
//   1. NavyAI's "The model 'x' does not exist" wording missed the model-not-
//      found classifier (the model id sits between "model" and "does not
//      exist"), so every stale row was booked as a per-key bad request.
//   2. A 402 benched only the one model+key that failed, so the same broke
//      HuggingFace key was retried on two more models in the same request.
//   3. The exhaustion ladder rendered 400 "rejected the request as invalid"
//      because the LAST error was bad-request shaped, although 3 of 8 attempts
//      were out of credits and none said anything about the request.

vi.mock('../../services/health.js', () => ({
  checkKeyHealth: vi.fn(),
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  newFallbackState,
  recordRetryableFailure,
  classifyAttemptError,
  cooldownDecisionForError,
  exhaustedRetryError,
  runFallbackLoop,
  resetModelFailureWindows,
  type AttemptRecord,
  type AttemptErrorClass,
  type FallbackHooks,
} from '../../lib/fallback-loop.js';
import {
  isModelNotFoundError,
  isProviderBadRequestError,
  isRetryableError,
  isModelAccessForbiddenError,
} from '../../lib/error-classify.js';
import {
  isOnCooldown,
  clearCooldownsForKey,
  resetKeyLocalityCache,
} from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

// A platform the bundled baseline seeds with several models, so the key-wide
// bench has real rows to walk (the 402 test needs the models table).
const PLATFORM = 'groq';
let keyA = 0;
let keyB = 0;
let models: { id: number; model_id: string }[] = [];

function insertKey(label: string): number {
  const { encrypted, iv, authTag } = encrypt(`test-${label}`);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(PLATFORM, label, encrypted, iv, authTag);
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

// The exact upstream bodies from the report.
const NAVY_STALE = (id = 'o3-mini') => Object.assign(
  new Error(`NavyAI API error 400: The model '${id}' does not exist or is not supported for chat completions.`),
  { status: 400 },
);
const HF_402 = () => Object.assign(
  new Error('HuggingFace API error 402: Payment required'),
  { status: 402 },
);
// A genuine request-shape rejection, for contrast: stays provider_bad_request.
const REAL_BAD_REQUEST = () => Object.assign(
  new Error('Google API error 400: Invalid JSON payload received. Unknown name "x-google-enum-descriptions"'),
  { status: 400 },
);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  keyA = insertKey('key-a');
  keyB = insertKey('key-b');
  resetKeyLocalityCache();
  models = db.prepare(
    'SELECT id, model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY id',
  ).all(PLATFORM) as { id: number; model_id: string }[];
  expect(models.length).toBeGreaterThanOrEqual(3);
});

beforeEach(() => {
  clearCooldownsForKey(keyA);
  clearCooldownsForKey(keyB);
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  resetModelFailureWindows();
});

// ── 1. classification ────────────────────────────────────────────────────────

describe("NavyAI \"The model 'x' does not exist\" is a stale model, not a bad request", () => {
  it('matches the exact reported body and its quoting variants', () => {
    expect(isModelNotFoundError(NAVY_STALE())).toBe(true);
    expect(isModelNotFoundError(NAVY_STALE('gpt-5-search-api'))).toBe(true);
    expect(isModelNotFoundError(new Error('API error 400: The model "o3" does not exist'))).toBe(true);
    expect(isModelNotFoundError(new Error('API error 400: model o4-mini does not exist'))).toBe(true);
    expect(isModelNotFoundError(new Error("API error 400: Model `gpt-5.4-mini` doesn't exist"))).toBe(true);
    // Only the second half of the NavyAI sentence, on its own.
    expect(isModelNotFoundError(new Error('API error 400: o3-mini is not supported for chat completions'))).toBe(true);
    // The pre-existing bare phrasing still matches.
    expect(isModelNotFoundError(new Error('API error 400: model does not exist'))).toBe(true);
  });

  it('still fails over (retryable) and classifies for the trail as model_not_found', () => {
    expect(isRetryableError(NAVY_STALE())).toBe(true);
    expect(classifyAttemptError(NAVY_STALE())).toBe('model_not_found');
  });

  it('leaves genuine request rejections and tier 403s where they were', () => {
    expect(isModelNotFoundError(REAL_BAD_REQUEST())).toBe(false);
    expect(isProviderBadRequestError(REAL_BAD_REQUEST())).toBe(true);
    expect(classifyAttemptError(REAL_BAD_REQUEST())).toBe('provider_bad_request');
    // #256: "model X is not available on the free tier" is a tier verdict.
    const tier = Object.assign(new Error('Groq API error 403: model llama-guard is not available on the free tier'), { status: 403 });
    expect(isModelNotFoundError(tier)).toBe(false);
    expect(isModelAccessForbiddenError(tier)).toBe(true);
    // Unrelated sentences that merely contain both words.
    expect(isModelNotFoundError(new Error('API error 400: parameter temperature does not exist for this model family'))).toBe(false);
  });

  it('rules the WHOLE model out for the rest of the request', () => {
    const state = newFallbackState();
    recordRetryableFailure(routeFor(models[0], keyA), NAVY_STALE(models[0].model_id), state);
    expect(state.skipModels.has(models[0].id)).toBe(true);
    // Not a platform verdict: the platform's other rows are still candidates.
    expect(state.skipPlatforms.has(PLATFORM)).toBe(false);
  });
});

// ── 2. 402 benches the key across the platform ───────────────────────────────

describe('a 402 benches the key on every model of its platform', () => {
  it('cools every enabled model on the broke key for the credit window and skips them for this request', () => {
    const state = newFallbackState();
    recordRetryableFailure(routeFor(models[0], keyA), HF_402(), state);

    expect(cooldownDecisionForError(routeFor(models[0], keyA), HF_402()).source).toBe('credit');
    for (const m of models) {
      expect(isOnCooldown(PLATFORM, m.model_id, keyA), m.model_id).toBe(true);
      expect(state.skipKeys.has(`${PLATFORM}:${m.model_id}:${keyA}`), m.model_id).toBe(true);
    }
  });

  it('leaves a sibling key (a different wallet) and the platform itself in play', () => {
    const state = newFallbackState();
    recordRetryableFailure(routeFor(models[0], keyA), HF_402(), state);
    for (const m of models) {
      expect(isOnCooldown(PLATFORM, m.model_id, keyB), m.model_id).toBe(false);
      expect(state.skipKeys.has(`${PLATFORM}:${m.model_id}:${keyB}`)).toBe(false);
    }
    // Unlike a suspension, the platform is NOT ruled out: keyB may have credits.
    expect(state.skipPlatforms.has(PLATFORM)).toBe(false);
  });

  it('a genuine bad request stays on the per-route path', () => {
    const state = newFallbackState();
    recordRetryableFailure(routeFor(models[0], keyA), REAL_BAD_REQUEST(), state);
    expect(isOnCooldown(PLATFORM, models[1].model_id, keyA)).toBe(false);
    expect(state.skipKeys.has(`${PLATFORM}:${models[1].model_id}:${keyA}`)).toBe(false);
  });
});

// ── 3. exhaustion ladder ─────────────────────────────────────────────────────

const record = (classes: AttemptErrorClass[]): AttemptRecord[] =>
  classes.map((errorClass, i) => ({ platform: 'fake', modelId: `m${i}`, keyOrdinal: 1 + (i % 2), errorClass }));

describe('exhaustedRetryError only blames the request when every attempt did', () => {
  it("the reported trail (5× bad request + 3× out of credits) renders a 502, not 'rejected as invalid'", () => {
    const attempts = record([
      'provider_bad_request', 'provider_bad_request', 'provider_bad_request', 'out_of_credits',
      'provider_bad_request', 'out_of_credits', 'out_of_credits', 'provider_bad_request',
    ]);
    const body = exhaustedRetryError(NAVY_STALE(), 20, { attempts, timedOut: true, budgetMs: 45_000 });
    expect(body.status).toBe(502);
    expect(body.kind).toBe('upstream');
    expect(body.code).toBe('upstream_failed');
    expect(body.message).not.toContain('rejected the request as invalid');
    // Names the mix so the reader sees what actually happened…
    expect(body.message).toContain('provider_bad_request ×5');
    expect(body.message).toContain('out_of_credits ×3');
    // …and neither promises the request was fine nor blames it outright.
    expect(body.message).not.toContain('not a problem with your request');
    expect(body.message).toContain('rejected the request shape');
    expect(body.message).toContain('retry time budget 45s exceeded');
    expect(body.message).toContain('Attempt trail:');
  });

  it('a unanimous bad-request trail keeps the 400 invalid_request contract', () => {
    const body = exhaustedRetryError(REAL_BAD_REQUEST(), 20, { attempts: record(['provider_bad_request', 'provider_bad_request']) });
    expect(body.status).toBe(400);
    expect(body.code).toBe('provider_rejected_request');
    expect(body.message).toContain('rejected the request as invalid');
  });

  it('the legacy no-trail shape still falls back to the last error', () => {
    const body = exhaustedRetryError(REAL_BAD_REQUEST(), 20, { attempts: [] });
    expect(body.status).toBe(400);
    expect(body.code).toBe('provider_rejected_request');
  });

  it('a mix with no bad-request hop keeps the plain provider-side wording', () => {
    const body = exhaustedRetryError(HF_402(), 20, { attempts: record(['model_not_found', 'out_of_credits', 'upstream_error']) });
    expect(body.status).toBe(502);
    expect(body.message).toContain('not a problem with your request');
    expect(body.message).toContain('model_not_found ×1');
  });

  it('with the classifier fix the same trail reads stale models + credits and renders 502 end to end', () => {
    // What the reporter's chain becomes once NavyAI's wording is classified:
    // every navy hop is model_not_found, every HF hop out_of_credits.
    const attempts = record([
      'model_not_found', 'model_not_found', 'model_not_found', 'out_of_credits',
      'model_not_found', 'out_of_credits', 'out_of_credits', 'model_not_found',
    ]);
    const body = exhaustedRetryError(NAVY_STALE(), 20, { attempts });
    expect(body.status).toBe(502);
    expect(body.message).toContain('model_not_found ×5');
    expect(body.message).not.toContain('rejected the request as invalid');
  });
});

// ── End to end through the loop: the reported chain collapses to two hops ────

describe('runFallbackLoop on the reported chain', () => {
  function hooks(overrides: Partial<FallbackHooks>): FallbackHooks {
    return {
      state: newFallbackState(),
      timeBudgetMs: 0,
      route: () => { throw new Error('unused'); },
      dispatch: async () => 'done',
      logFailure: () => {},
      onFatal: () => {},
      onRoutingExhausted: () => {},
      onExhausted: () => {},
      ...overrides,
    };
  }

  it('skips the stale model on its sibling key and the broke key on its sibling models, then serves', async () => {
    const state = newFallbackState();
    const dispatched: string[] = [];
    const onExhausted = vi.fn();
    const onRoutingExhausted = vi.fn();

    // Candidate order, mimicking a router that walks the chain and honours
    // skipModels / skipKeys / cooldowns:
    //   stale/keyA → stale/keyB (must be skipped: model-level)
    //   → m1/keyA 402 → m2/keyA (must be skipped: key-level) → m2/keyB serves.
    const stale = { id: 987_654, model_id: 'o3-mini' };
    const candidates: RouteResult[] = [
      routeFor(stale, keyA, 'navy'),
      routeFor(stale, keyB, 'navy'),
      routeFor(models[1], keyA),
      routeFor(models[2], keyA),
      routeFor(models[2], keyB),
    ];
    const route = (): RouteResult => {
      for (const c of candidates) {
        if (state.skipModels.has(c.modelDbId)) continue;
        if (state.skipKeys.has(`${c.platform}:${c.modelId}:${c.keyId}`)) continue;
        if (isOnCooldown(c.platform, c.modelId, c.keyId)) continue;
        return c;
      }
      throw Object.assign(new Error('All models exhausted'), { status: 429 });
    };
    const dispatch = vi.fn(async (r: RouteResult) => {
      dispatched.push(`${r.platform}/${r.modelId}/key${r.keyId === keyA ? 'A' : 'B'}`);
      if (r.platform === 'navy') throw NAVY_STALE(r.modelId);
      if (r.keyId === keyA) throw HF_402();
      return 'done' as const;
    });

    await runFallbackLoop(hooks({ state, maxRetries: 20, route, dispatch, onExhausted, onRoutingExhausted }));

    expect(onExhausted).not.toHaveBeenCalled();
    expect(onRoutingExhausted).not.toHaveBeenCalled();
    expect(dispatched).toEqual([
      `navy/o3-mini/keyA`,
      `${PLATFORM}/${models[1].model_id}/keyA`,
      `${PLATFORM}/${models[2].model_id}/keyB`,
    ]);
  });
});
