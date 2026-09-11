import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Account-level suspension: a relay answers EVERY model behind one key with the
// same 403 (observed on NavyAI: "The Free plan is temporarily disabled due to
// abuse"). Classified as model-forbidden it benched a single model per attempt,
// so on a platform with a large catalog each request spent its whole failover
// budget re-discovering the same dead account. The key must sink out of routing
// on every model of the platform at once.

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
  resetModelFailureWindows,
} from '../../lib/fallback-loop.js';
import { isAccountSuspendedError, isModelNotFoundError } from '../../lib/error-classify.js';
import {
  isOnCooldown,
  getActiveCooldownsForKeys,
  clearCooldownsForKey,
  resetKeyLocalityCache,
  setCooldownCeilingMs,
  PAYMENT_REQUIRED_COOLDOWN_MS,
} from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

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

function routeFor(model: { id: number; model_id: string }, keyId: number): RouteResult {
  return {
    provider: {} as any,
    modelId: model.model_id,
    modelDbId: model.id,
    apiKey: 'k',
    keyId,
    platform: PLATFORM,
    displayName: model.model_id,
    rpdLimit: null,
    tpdLimit: null,
  };
}

// The exact NavyAI body observed on the gray tier (URL redacted by the proxy).
const SUSPENDED = () => Object.assign(
  new Error('NavyAI API error 403: The Free plan is temporarily disabled due to abuse. You can purchase a plan at [redacted-url] to continue using the API.'),
  { status: 403 },
);
// A model-tier 403 behind an otherwise-valid key (#256): stays per-model.
const TIER_403 = () => Object.assign(
  new Error('Groq API error 403: model llama-guard is not available on the free tier'),
  { status: 403 },
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
    'SELECT id, model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY id'
  ).all(PLATFORM) as { id: number; model_id: string }[];
  expect(models.length).toBeGreaterThanOrEqual(3);
});

beforeEach(() => {
  // Memory AND disk: isOnCooldown falls back to the in-process map when no
  // persisted row exists, so a table wipe alone leaks the last case's bench.
  clearCooldownsForKey(keyA);
  clearCooldownsForKey(keyB);
  resetModelFailureWindows();
});

describe('isAccountSuspendedError', () => {
  it('matches the NavyAI plan-disabled 403 and generic account-suspension wording', () => {
    expect(isAccountSuspendedError(SUSPENDED())).toBe(true);
    expect(isAccountSuspendedError(Object.assign(new Error('API error 403: Your account has been suspended'), { status: 403 }))).toBe(true);
    expect(isAccountSuspendedError(new Error('API error 403: account is banned'))).toBe(true);
  });

  it('is status-gated: the wording alone never condemns a key', () => {
    expect(isAccountSuspendedError(TIER_403())).toBe(false);
    expect(isAccountSuspendedError(Object.assign(new Error('Rate limited; note your plan is disabled for bursts'), { status: 429 }))).toBe(false);
    expect(isAccountSuspendedError(Object.assign(new Error('The Free plan is temporarily disabled due to abuse'), { status: 400 }))).toBe(false);
  });

  it('is not the model-not-found family', () => {
    expect(isModelNotFoundError(SUSPENDED())).toBe(false);
  });
});

describe('a suspended account benches the whole key, not one model', () => {
  it('cools every enabled model of the platform on the failing key for the credit window', () => {
    const state = newFallbackState();
    recordRetryableFailure(routeFor(models[0], keyA), SUSPENDED(), state);

    for (const m of models) {
      expect(isOnCooldown(PLATFORM, m.model_id, keyA), m.model_id).toBe(true);
    }
    // Credit-length bench (a day), on the sibling models too, not the 90s
    // transient or the per-model tier window.
    expect(cooldownDecisionForError(routeFor(models[0], keyA), SUSPENDED()).source).toBe('credit');
    const cds = getActiveCooldownsForKeys([keyA]).get(keyA) ?? [];
    const sibling = cds.find(c => c.modelId === models[1].model_id);
    expect(sibling).toBeDefined();
    expect(sibling!.expiresAtMs - Date.now()).toBeGreaterThan(PAYMENT_REQUIRED_COOLDOWN_MS - 60_000);
    // The platform is out for the rest of THIS request.
    expect(state.skipPlatforms.has(PLATFORM)).toBe(true);
  });

  it('leaves a sibling key on the same platform alone', () => {
    recordRetryableFailure(routeFor(models[0], keyA), SUSPENDED(), newFallbackState());
    for (const m of models) {
      expect(isOnCooldown(PLATFORM, m.model_id, keyB), m.model_id).toBe(false);
    }
  });

  it('keeps a model-tier 403 on the per-model path', () => {
    const state = newFallbackState();
    recordRetryableFailure(routeFor(models[0], keyA), TIER_403(), state);
    expect(isOnCooldown(PLATFORM, models[0].model_id, keyA)).toBe(true);
    expect(isOnCooldown(PLATFORM, models[1].model_id, keyA)).toBe(false);
    expect(state.skipPlatforms.has(PLATFORM)).toBe(false);
    expect(cooldownDecisionForError(routeFor(models[0], keyA), TIER_403()).source).toBe('tier');
  });


  // #952: the bench is one of the router's OWN guesses, so an operator ceiling
  // caps it like the 402/403 benches it borrows its duration from.
  it('honours the operator cooldown ceiling', () => {
    setCooldownCeilingMs(10 * 60_000);
    try {
      recordRetryableFailure(routeFor(models[0], keyA), SUSPENDED(), newFallbackState());
      const cds = getActiveCooldownsForKeys([keyA]).get(keyA) ?? [];
      expect(cds.length).toBeGreaterThan(1);
      for (const cd of cds) {
        expect(cd.expiresAtMs - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 1_000);
      }
    } finally {
      setCooldownCeilingMs(null);
    }
  });
  it('classifies for the attempt trail as forbidden (a 403 is what the client sees)', () => {
    expect(classifyAttemptError(SUSPENDED())).toBe('forbidden');
  });
});
