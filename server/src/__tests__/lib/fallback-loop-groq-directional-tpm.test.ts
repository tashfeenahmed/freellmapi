import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Groq orgs with split per-minute limits reject on ITPM (prompt tokens) or
// OTPM (expected completion tokens) separately from the combined TPM. Live
// failure: one OTPM 1000 rejection was learned as tpm_limit = 1000 on a
// 7000-ITPM model, and from then on the router sized out every request over
// 1000 tokens on that model — permanently, since learned limits never rise.

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
} from '../../lib/fallback-loop.js';
import { isOnCooldown, resetKeyLocalityCache } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

const PLATFORM = 'groq';
const OTPM_BODY = 'Groq API error 429: Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1838. The request\'s expected output tokens exceed the limit.';
const ITPM_BODY = 'Groq API error 413: Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Requested 16136, please reduce your message size and try again.';
// A full per-minute window (not an oversized request) uses Groq's "Rate limit
// reached … Used N" shape; these follow its TPM wording with the directional axis.
const OTPM_WINDOW_BODY = 'Groq API error 429: Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Used 900, Requested 300. Please try again in 12s.';
const ITPM_WINDOW_BODY = 'Groq API error 429: Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Used 6500, Requested 1500. Please try again in 8s.';

let keyId = 0;
let model: { id: number; model_id: string };

function route(): RouteResult {
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

const tpmLimit = () =>
  (getDb().prepare('SELECT tpm_limit FROM models WHERE id = ?').get(model.id) as { tpm_limit: number | null }).tpm_limit;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  const { encrypted, iv, authTag } = encrypt('test-key');
  keyId = Number(db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'key', ?, ?, ?, 'healthy', 1)
  `).run(PLATFORM, encrypted, iv, authTag).lastInsertRowid);
  resetKeyLocalityCache();
  model = db.prepare('SELECT id, model_id FROM models WHERE platform = ? LIMIT 1').get(PLATFORM) as typeof model;
});

beforeEach(() => {
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  getDb().prepare('UPDATE models SET tpm_limit = 7000 WHERE id = ?').run(model.id);
  resetModelFailureWindows();
});

describe('Groq OTPM rejection', () => {
  it('keeps tpm_limit at the input ceiling', () => {
    recordRetryableFailure(route(), Object.assign(new Error(OTPM_BODY), { status: 429 }), newFallbackState());
    expect(tpmLimit()).toBe(7000);
  });

  it('stays unchanged across repeated rejections', () => {
    for (let i = 0; i < 5; i++) {
      recordRetryableFailure(route(), Object.assign(new Error(OTPM_BODY), { status: 429 }), newFallbackState());
    }
    expect(tpmLimit()).toBe(7000);
  });

  it('skips the model for this request only — no cooldown, so the next request can use it', () => {
    const state = newFallbackState();
    recordRetryableFailure(route(), Object.assign(new Error(OTPM_BODY), { status: 429 }), state);
    expect(state.skipModels.has(model.id)).toBe(true);
    expect(isOnCooldown(PLATFORM, model.model_id, keyId)).toBe(false);
  });

  it('does not latch the expected-output count as the request size', () => {
    const state = newFallbackState();
    recordRetryableFailure(route(), Object.assign(new Error(OTPM_BODY), { status: 429 }), state);
    expect(state.observedTotalTokens).toBeUndefined();
    expect(state.observedInputTokens).toBeUndefined();
  });
});

describe('Groq OTPM window exhausted (rate limit reached)', () => {
  it('cools the route down for the window but keeps tpm_limit at the input ceiling', () => {
    recordRetryableFailure(route(), Object.assign(new Error(OTPM_WINDOW_BODY), { status: 429 }), newFallbackState());
    expect(isOnCooldown(PLATFORM, model.model_id, keyId)).toBe(true);
    expect(tpmLimit()).toBe(7000);
  });
});

describe('Groq ITPM window exhausted (rate limit reached)', () => {
  it('cools the route down and lowers a too-high tpm_limit to the input ceiling', () => {
    getDb().prepare('UPDATE models SET tpm_limit = 70000 WHERE id = ?').run(model.id);
    recordRetryableFailure(route(), Object.assign(new Error(ITPM_WINDOW_BODY), { status: 429 }), newFallbackState());
    expect(isOnCooldown(PLATFORM, model.model_id, keyId)).toBe(true);
    expect(tpmLimit()).toBe(7000);
  });
});

describe('Groq ITPM rejection', () => {
  it('lowers a too-high tpm_limit to the input ceiling', () => {
    getDb().prepare('UPDATE models SET tpm_limit = 70000 WHERE id = ?').run(model.id);
    recordRetryableFailure(route(), Object.assign(new Error(ITPM_BODY), { status: 413 }), newFallbackState());
    expect(tpmLimit()).toBe(7000);
  });

  it('latches the prompt size as an input-only reading', () => {
    const state = newFallbackState();
    recordRetryableFailure(route(), Object.assign(new Error(ITPM_BODY), { status: 413 }), state);
    expect(state.observedInputTokens).toBe(16136);
    expect(state.observedTotalTokens).toBeUndefined();
  });
});
