import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';
import { newFallbackState, recordRetryableFailure } from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';

// Custom relays all share the platform id 'custom' (#651), so a platform-wide
// skip would take the healthy relays with it. End to end: after an HTTP 405 on
// one relay, recordRetryableFailure expands that relay into per-model skips for
// the rest of the request, and routeRequest() must then land on a sibling relay
// that shares the same platform — without touching endpoints that were never
// ruled out. This is the mechanism that replaces per-model-only skipping, which
// left the other rows of a 34-model relay still payable.

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({
  checkKeyHealth: mockCheckKeyHealth,
  markKeyHealthyFromRequest: vi.fn(),
}));

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
  };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const RELAY_A = 'http://192.168.10.70:3066/v1';
const RELAY_B = 'http://relay-b.example/v1';

function addRelay(baseUrl: string, label: string): number {
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', ?, 'enc', 'iv', 'tag', 'healthy', 1, ?)
  `).run(label, baseUrl);
  return Number(info.lastInsertRowid);
}

function addModel(modelId: string, keyId: number, endpointScope: string, priority: number): number {
  const info = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, key_id, endpoint_scope)
    VALUES ('custom', ?, ?, 50, 50, 'Medium', 1, ?, ?)
  `).run(modelId, modelId, keyId, endpointScope);
  const modelDbId = Number(info.lastInsertRowid);
  getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, priority);
  return modelDbId;
}

const html405 = () => Object.assign(
  new Error('Custom (OpenAI-compatible) API error 405: <!doctype html><title>405</title>'),
  { status: 405, providerRejection: 'upstream' as const },
);

function routeThroughA(keyId: number, modelDbId: number): RouteResult {
  return {
    provider: {} as any,
    modelId: 'glm-5.3',
    modelDbId,
    apiKey: 'k',
    keyId,
    keyLabel: null,
    platform: 'custom',
    displayName: 'glm-5.3',
    contextWindow: null,
    endpointScope: RELAY_A,
    rpdLimit: null,
    tpdLimit: null,
  } as RouteResult;
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  process.env.DEV_MODE = 'true';
  process.env.NODE_ENV = 'test';
  mockCheckKeyHealth.mockReset();
  setRoutingStrategy('priority');
  const db = getDb();
  db.exec(`
    DELETE FROM settings WHERE key = 'active_profile_id';
    DELETE FROM fallback_config;
    DELETE FROM profile_models;
    DELETE FROM models;
    DELETE FROM api_keys;
  `);

  (ratelimit.canMakeRequest as any).mockReturnValue(true);
  (ratelimit.canUseTokens as any).mockReturnValue(true);
  (ratelimit.isOnCooldown as any).mockReturnValue(false);
});

describe('405 relay skip is honoured by routeRequest', () => {
  it('routes to the highest-priority relay when nothing is ruled out', () => {
    const keyA = addRelay(RELAY_A, 'agent2api');
    addModel('glm-5.3', keyA, RELAY_A, 1);
    expect(routeRequest(100).endpointScope).toBe(RELAY_A);
  });

  it('after one 405, routes to the sibling relay instead of the refusing one', () => {
    const keyA = addRelay(RELAY_A, 'agent2api');
    const keyB = addRelay(RELAY_B, 'relay-b');
    const aRow = addModel('glm-5.3', keyA, RELAY_A, 1);
    addModel('glm-5.3', keyB, RELAY_B, 2);

    const state = newFallbackState();
    recordRetryableFailure(routeThroughA(keyA, aRow), html405(), state);

    const result = routeRequest(100, undefined, undefined, false, false, state.skipModels);
    expect(result.platform).toBe('custom');
    expect(result.endpointScope).toBe(RELAY_B);
    expect(result.modelId).toBe('glm-5.3');
  });

  it('skips every model row of the ruled-out relay, not just the failed one', () => {
    // The production shape: a crowded relay whose other rows would each re-pay
    // the same 80s+ 405 hop.
    const keyA = addRelay(RELAY_A, 'agent2api');
    const keyB = addRelay(RELAY_B, 'relay-b');
    const aRow = addModel('glm-5.3', keyA, RELAY_A, 1);
    for (const id of ['glm-5.3-flash', 'qwen3-coder', 'deepseek-v3.1']) addModel(id, keyA, RELAY_A, 0);
    addModel('deepseek-v3.1', keyB, RELAY_B, 2);

    const state = newFallbackState();
    recordRetryableFailure(routeThroughA(keyA, aRow), html405(), state);

    const result = routeRequest(100, undefined, undefined, false, false, state.skipModels);
    expect(result.endpointScope).toBe(RELAY_B);
  });

  it('a 405 on relay B leaves relay A reachable (per scope, not per platform)', () => {
    const keyA = addRelay(RELAY_A, 'agent2api');
    const keyB = addRelay(RELAY_B, 'relay-b');
    addModel('glm-5.3', keyA, RELAY_A, 1);
    const bRow = addModel('glm-5.3', keyB, RELAY_B, 0);

    const state = newFallbackState();
    recordRetryableFailure(
      { ...routeThroughA(keyB, bRow), endpointScope: RELAY_B, keyId: keyB, modelId: 'glm-5.3' } as RouteResult,
      html405(),
      state,
    );

    const result = routeRequest(100, undefined, undefined, false, false, state.skipModels);
    expect(result.endpointScope).toBe(RELAY_A);
  });
});
