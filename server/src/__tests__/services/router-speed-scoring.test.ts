import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  refreshStatsCache, getRoutingScores, setRoutingStrategy,
  writeObservedSpeedRanks, resetSpeedRankWriteback,
} from '../../services/router.js';
import { observedSpeedRank, TIMEOUT_LATENCY_CAP_MS } from '../../services/scoring.js';
import { upsertModelOverrides } from '../../services/model-state.js';
import { getDb, initDb } from '../../db/index.js';
import { addToActiveChain } from '../helpers/chain.js';

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function addModel(opts: {
  platform: string; modelId: string; name: string; speedRank?: number; priority?: number;
}): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
    VALUES (?, ?, ?, 3, ?, 'Large', '~50M', 1)
  `).run(opts.platform, opts.modelId, opts.name, opts.speedRank ?? 5);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(opts.platform, opts.modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)')
    .run(id, opts.priority ?? 1);
  addToActiveChain(id, opts.priority ?? 1);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(opts.platform);
  return id;
}

// Fresh rows (age 0 → decay weight 1) so the arithmetic in the assertions is exact.
function addRequests(platform: string, modelId: string, opts: {
  count: number; status: string; outTokens?: number; latencyMs?: number;
  ttfbMs?: number | null; error?: string | null;
}) {
  const ins = getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?)
  `);
  for (let i = 0; i < opts.count; i++) {
    ins.run(platform, modelId, opts.status, opts.outTokens ?? 0,
      opts.latencyMs ?? 0, opts.error ?? null, opts.ttfbMs ?? null);
  }
}

function speedOf(modelId: string): number {
  const { scores } = getRoutingScores();
  const row = scores.find(s => s.modelId === modelId);
  if (!row) throw new Error(`no score row for ${modelId}`);
  return row.speed;
}

function speedRankOf(platform: string, modelId: string): number {
  return (getDb().prepare('SELECT speed_rank FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { speed_rank: number }).speed_rank;
}

describe('speed scoring: timeouts count against speed (#619)', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests; DELETE FROM model_overrides;');
    setRoutingStrategy('balanced');
    resetSpeedRankWriteback();
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('the same successes score measurably slower once timeouts are in the window', () => {
    addModel({ platform: 'google', modelId: 'clean', name: 'Clean', priority: 1 });
    addModel({ platform: 'groq', modelId: 'timeouty', name: 'Timeouty', priority: 2 });

    // Identical successful traffic on both.
    for (const [platform, modelId] of [['google', 'clean'], ['groq', 'timeouty']] as const) {
      addRequests(platform, modelId, { count: 40, status: 'success', outTokens: 100, latencyMs: 1000, ttfbMs: 200 });
    }
    // …but one of them also times out constantly. A timeout is logged as an
    // 'error' row whose text carries the abort/timeout marker.
    addRequests('groq', 'timeouty', {
      count: 10, status: 'error', outTokens: 0, latencyMs: 120_000, ttfbMs: null,
      error: 'The operation was aborted (groq, chat, 120s)',
    });

    refreshStatsCache(getDb(), true);
    const clean = speedOf('clean');
    const timeouty = speedOf('timeouty');
    expect(timeouty).toBeLessThan(clean - 0.2);
  });

  it('a model that only ever times out lands at the bottom of the speed axis', () => {
    addModel({ platform: 'google', modelId: 'dead', name: 'Dead', priority: 1 });
    addRequests('google', 'dead', {
      count: 25, status: 'error', outTokens: 0, latencyMs: 90_000, ttfbMs: null,
      error: 'google stream stalled: no data for 90000ms (timeout)',
    });

    refreshStatsCache(getDb(), true);
    // Not the optimistic no-data prior (0.6) — it timed out every single time.
    expect(speedOf('dead')).toBeLessThan(0.05);
  });

  it('one pathological hang is capped, not allowed to dominate the window', () => {
    addModel({ platform: 'google', modelId: 'capped', name: 'Capped', priority: 1 });
    addModel({ platform: 'groq', modelId: 'uncapped', name: 'Uncapped', priority: 2 });
    for (const [platform, modelId] of [['google', 'capped'], ['groq', 'uncapped']] as const) {
      addRequests(platform, modelId, { count: 40, status: 'success', outTokens: 100, latencyMs: 1000, ttfbMs: 200 });
      addRequests(platform, modelId, {
        count: 1, status: 'error', outTokens: 0,
        latencyMs: modelId === 'capped' ? TIMEOUT_LATENCY_CAP_MS : TIMEOUT_LATENCY_CAP_MS * 50,
        error: 'The operation was aborted (x, chat, 120s)',
      });
    }
    refreshStatsCache(getDb(), true);
    expect(speedOf('uncapped')).toBeCloseTo(speedOf('capped'), 10);
  });

  it('a non-timeout failure leaves the speed axis alone (it only costs reliability)', () => {
    addModel({ platform: 'google', modelId: 'fast', name: 'Fast', priority: 1 });
    addModel({ platform: 'groq', modelId: 'refusing', name: 'Refusing', priority: 2 });
    for (const [platform, modelId] of [['google', 'fast'], ['groq', 'refusing']] as const) {
      addRequests(platform, modelId, { count: 40, status: 'success', outTokens: 100, latencyMs: 1000, ttfbMs: 200 });
    }
    addRequests('groq', 'refusing', {
      count: 20, status: 'error', outTokens: 0, latencyMs: 200,
      error: 'API error 401: invalid api key',
    });

    refreshStatsCache(getDb(), true);
    expect(speedOf('refusing')).toBeCloseTo(speedOf('fast'), 10);
    const { scores } = getRoutingScores();
    const refusing = scores.find(s => s.modelId === 'refusing')!;
    const fast = scores.find(s => s.modelId === 'fast')!;
    expect(refusing.reliability).toBeLessThan(fast.reliability);
  });

  it("a 'canceled' row (#752 — client hung up) affects neither speed nor reliability", () => {
    addModel({ platform: 'google', modelId: 'steady', name: 'Steady', priority: 1 });
    addModel({ platform: 'groq', modelId: 'hungup', name: 'HungUp', priority: 2 });
    for (const [platform, modelId] of [['google', 'steady'], ['groq', 'hungup']] as const) {
      addRequests(platform, modelId, { count: 40, status: 'success', outTokens: 100, latencyMs: 1000, ttfbMs: 200 });
    }
    // Long-latency canceled rows would read as timeouts/failures if counted.
    addRequests('groq', 'hungup', {
      count: 20, status: 'canceled', outTokens: 0, latencyMs: 120_000,
      error: 'client disconnected after 120.0s; upstream request canceled',
    });

    refreshStatsCache(getDb(), true);
    expect(speedOf('hungup')).toBeCloseTo(speedOf('steady'), 10);
    const { scores } = getRoutingScores();
    const hungup = scores.find(s => s.modelId === 'hungup')!;
    const steady = scores.find(s => s.modelId === 'steady')!;
    expect(hungup.reliability).toBeCloseTo(steady.reliability, 10);
  });
});

describe('observed speed_rank writeback (#619)', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests; DELETE FROM model_overrides;');
    setRoutingStrategy('balanced');
    // Drain the periodic writeback against the now-empty DB so its interval gate
    // is closed: each test below drives writeObservedSpeedRanks itself and wants
    // an exact count. The one test that checks the automatic tail re-opens it.
    resetSpeedRankWriteback();
    refreshStatsCache(getDb(), true);
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('maps the speed axis onto the catalog rank scale (1 = fastest, low is fast)', () => {
    expect(observedSpeedRank(1)).toBe(1);
    expect(observedSpeedRank(0)).toBe(10);
    expect(observedSpeedRank(0.5)).toBeGreaterThan(observedSpeedRank(0.9));
    // Out-of-range inputs are clamped, never NaN.
    expect(observedSpeedRank(5)).toBe(1);
    expect(observedSpeedRank(-5)).toBe(10);
  });

  it('writes an observed rank for a well-sampled model', () => {
    addModel({ platform: 'google', modelId: 'quick', name: 'Quick', speedRank: 9 });
    addRequests('google', 'quick', { count: 40, status: 'success', outTokens: 4000, latencyMs: 1000, ttfbMs: 100 });

    refreshStatsCache(getDb(), true);
    expect(writeObservedSpeedRanks(getDb())).toBe(1);
    // Genuinely fast traffic (4000 tok/s, 100ms TTFB) → the top of the scale.
    expect(speedRankOf('google', 'quick')).toBe(1);
  });

  it('demotes a model whose observed speed is dragged down by timeouts', () => {
    addModel({ platform: 'google', modelId: 'slowish', name: 'Slowish', speedRank: 1 });
    addRequests('google', 'slowish', { count: 30, status: 'success', outTokens: 100, latencyMs: 1000, ttfbMs: 200 });
    addRequests('google', 'slowish', {
      count: 30, status: 'error', outTokens: 0, latencyMs: 120_000,
      error: 'The operation was aborted (google, chat, 120s)',
    });

    refreshStatsCache(getDb(), true);
    writeObservedSpeedRanks(getDb());
    expect(speedRankOf('google', 'slowish')).toBeGreaterThan(5);
  });

  it('leaves a low-sample model on its catalog rank', () => {
    addModel({ platform: 'google', modelId: 'shy', name: 'Shy', speedRank: 7 });
    addRequests('google', 'shy', { count: 3, status: 'success', outTokens: 4000, latencyMs: 1000, ttfbMs: 100 });

    refreshStatsCache(getDb(), true);
    expect(writeObservedSpeedRanks(getDb())).toBe(0);
    expect(speedRankOf('google', 'shy')).toBe(7);
  });

  it('never clobbers a user-set speed_rank override', () => {
    addModel({ platform: 'google', modelId: 'pinned', name: 'Pinned', speedRank: 2 });
    upsertModelOverrides(getDb(), 'google', 'pinned', { speedRank: 2 });
    addRequests('google', 'pinned', { count: 40, status: 'success', outTokens: 4000, latencyMs: 1000, ttfbMs: 100 });

    refreshStatsCache(getDb(), true);
    expect(writeObservedSpeedRanks(getDb())).toBe(0);
    expect(speedRankOf('google', 'pinned')).toBe(2);
  });

  it('an override on a DIFFERENT field does not block the observed rank', () => {
    addModel({ platform: 'google', modelId: 'renamed', name: 'Renamed', speedRank: 9 });
    upsertModelOverrides(getDb(), 'google', 'renamed', { displayName: 'My Name' });
    addRequests('google', 'renamed', { count: 40, status: 'success', outTokens: 4000, latencyMs: 1000, ttfbMs: 100 });

    refreshStatsCache(getDb(), true);
    expect(writeObservedSpeedRanks(getDb())).toBe(1);
    expect(speedRankOf('google', 'renamed')).toBe(1);
  });

  it('is idempotent — a second pass writes nothing', () => {
    addModel({ platform: 'google', modelId: 'steady', name: 'Steady', speedRank: 9 });
    addRequests('google', 'steady', { count: 40, status: 'success', outTokens: 4000, latencyMs: 1000, ttfbMs: 100 });

    refreshStatsCache(getDb(), true);
    expect(writeObservedSpeedRanks(getDb())).toBe(1);
    expect(writeObservedSpeedRanks(getDb())).toBe(0);
  });

  it('refreshStatsCache drives the writeback on its own', () => {
    addModel({ platform: 'google', modelId: 'auto', name: 'Auto', speedRank: 9 });
    addRequests('google', 'auto', { count: 40, status: 'success', outTokens: 4000, latencyMs: 1000, ttfbMs: 100 });

    resetSpeedRankWriteback();
    refreshStatsCache(getDb(), true);
    expect(speedRankOf('google', 'auto')).toBe(1);
  });
});
