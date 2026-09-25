import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// #1230: custom endpoints default to supports_tools = 1, so a relay model that
// answers every tool-carrying request with a 400 stayed a first-class candidate
// for tool requests. The only memory of the rejection was the 90s transient
// cooldown, so auto mode re-walked the same dead chain on every tool request
// until the operator disabled the models by hand. The loop now remembers those
// rejections per model+endpoint so the router can try such models last for
// tool requests, and only for tool requests.

vi.mock('../../services/health.js', () => ({
  checkKeyHealth: vi.fn(),
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  newFallbackState,
  recordRetryableFailure,
  recordUpstreamSuccess,
  resetModelFailureWindows,
  type FallbackState,
} from '../../lib/fallback-loop.js';
import {
  isToolBenched,
  resetToolCapability,
  TOOL_BENCH_MS,
  TOOL_REJECTION_LIMIT,
  TOOL_REJECTION_WINDOW_MS,
} from '../../lib/tool-capability.js';
import { clearCooldownsForKey, resetKeyLocalityCache } from '../../services/ratelimit.js';
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

function routeFor(model: { id: number; model_id: string }, keyId: number, extra: Partial<RouteResult> = {}): RouteResult {
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
    endpointScope: '',
    ...extra,
  } as RouteResult;
}

// The shape every OpenAI-compatible adapter throws for an upstream 400.
const BAD_REQUEST = () => Object.assign(
  new Error('Custom API error 400: tools is not supported by this model'),
  { status: 400 },
);
const CONTEXT_400 = () => Object.assign(
  new Error("Custom API error 400: This model's maximum context length is 8192 tokens"),
  { status: 400 },
);

function toolState(): FallbackState {
  const state = newFallbackState();
  state.wantsTools = true;
  return state;
}

const benched = (m: { model_id: string }, scope = '') => isToolBenched(PLATFORM, m.model_id, scope);

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
  clearCooldownsForKey(keyA);
  clearCooldownsForKey(keyB);
  resetModelFailureWindows();
  resetToolCapability();
});

describe('tool-request rejections are remembered per model (#1230)', () => {
  it('defers a model after the limit of DISTINCT tool requests it rejected', () => {
    for (let i = 0; i < TOOL_REJECTION_LIMIT - 1; i++) {
      recordRetryableFailure(routeFor(models[0], keyA), BAD_REQUEST(), toolState());
    }
    expect(benched(models[0])).toBe(false);
    recordRetryableFailure(routeFor(models[0], keyA), BAD_REQUEST(), toolState());
    expect(benched(models[0])).toBe(true);
    // Only the model that rejected is affected.
    expect(benched(models[1])).toBe(false);
  });

  it('counts one request once, however many keys of the model were tried', () => {
    const state = toolState();
    for (let i = 0; i < TOOL_REJECTION_LIMIT + 2; i++) {
      recordRetryableFailure(routeFor(models[0], i % 2 ? keyA : keyB), BAD_REQUEST(), state);
    }
    expect(benched(models[0])).toBe(false);
  });

  it('ignores requests that carry no tools', () => {
    for (let i = 0; i < TOOL_REJECTION_LIMIT + 2; i++) {
      recordRetryableFailure(routeFor(models[0], keyA), BAD_REQUEST(), newFallbackState());
    }
    expect(benched(models[0])).toBe(false);
  });

  it('ignores 400s that are really another class (context too large)', () => {
    for (let i = 0; i < TOOL_REJECTION_LIMIT + 2; i++) {
      recordRetryableFailure(routeFor(models[0], keyA), CONTEXT_400(), toolState());
    }
    expect(benched(models[0])).toBe(false);
  });

  it('forgets rejections that fall outside the window', () => {
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < TOOL_REJECTION_LIMIT - 1; i++) {
      recordRetryableFailure(routeFor(models[0], keyA), BAD_REQUEST(), toolState(), t0);
    }
    recordRetryableFailure(routeFor(models[0], keyA), BAD_REQUEST(), toolState(), t0 + TOOL_REJECTION_WINDOW_MS + 1);
    expect(isToolBenched(PLATFORM, models[0].model_id, '', t0 + TOOL_REJECTION_WINDOW_MS + 2)).toBe(false);
  });

  it('keeps two relays serving the same model id apart', () => {
    const relayA = { platform: 'custom', endpointScope: 'https://relay-a.example/v1' };
    for (let i = 0; i < TOOL_REJECTION_LIMIT; i++) {
      recordRetryableFailure(routeFor(models[0], keyA, relayA), BAD_REQUEST(), toolState());
    }
    expect(isToolBenched('custom', models[0].model_id, 'https://relay-a.example/v1')).toBe(true);
    expect(isToolBenched('custom', models[0].model_id, 'https://relay-b.example/v1')).toBe(false);
  });

  it('expires on its own', () => {
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < TOOL_REJECTION_LIMIT; i++) {
      recordRetryableFailure(routeFor(models[0], keyA), BAD_REQUEST(), toolState(), t0);
    }
    expect(isToolBenched(PLATFORM, models[0].model_id, '', t0 + TOOL_BENCH_MS - 1)).toBe(true);
    expect(isToolBenched(PLATFORM, models[0].model_id, '', t0 + TOOL_BENCH_MS + 1)).toBe(false);
  });
});

describe('a served tool request settles who was at fault (#1230)', () => {
  it('defers the models that rejected the same request straight away', () => {
    const state = toolState();
    recordRetryableFailure(routeFor(models[0], keyA), BAD_REQUEST(), state);
    recordRetryableFailure(routeFor(models[1], keyA), BAD_REQUEST(), state);
    expect(benched(models[0])).toBe(false);
    recordUpstreamSuccess(routeFor(models[2], keyA), 100, state);
    expect(benched(models[0])).toBe(true);
    expect(benched(models[1])).toBe(true);
    expect(benched(models[2])).toBe(false);
  });

  it('clears a model that serves a tool request after all', () => {
    for (let i = 0; i < TOOL_REJECTION_LIMIT; i++) {
      recordRetryableFailure(routeFor(models[0], keyA), BAD_REQUEST(), toolState());
    }
    expect(benched(models[0])).toBe(true);
    recordUpstreamSuccess(routeFor(models[0], keyA), 100, toolState());
    expect(benched(models[0])).toBe(false);
  });

  it('a malformed tool request that every model rejects defers nothing on its own', () => {
    // One broken client payload: every model 400s, nothing succeeds.
    const state = toolState();
    for (const m of models.slice(0, 3)) recordRetryableFailure(routeFor(m, keyA), BAD_REQUEST(), state);
    expect(models.slice(0, 3).some(m => benched(m))).toBe(false);
  });

  it('a success without tools teaches nothing about tool support', () => {
    for (let i = 0; i < TOOL_REJECTION_LIMIT; i++) {
      recordRetryableFailure(routeFor(models[0], keyA), BAD_REQUEST(), toolState());
    }
    recordUpstreamSuccess(routeFor(models[0], keyA), 100, newFallbackState());
    recordUpstreamSuccess(routeFor(models[0], keyA), 100);
    expect(benched(models[0])).toBe(true);
  });
});
