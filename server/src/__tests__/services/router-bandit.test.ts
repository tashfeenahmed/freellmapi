import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  routeRequest, refreshStatsCache, getRoutingStrategy, setRoutingStrategy, getRoutingScores,
} from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';

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

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

// Insert a model + its fallback entry; returns the model id.
function addModel(opts: {
  platform: string; modelId: string; name: string;
  intelligenceRank: number; sizeLabel: string; budget: string; priority: number;
}): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(opts.platform, opts.modelId, opts.name, opts.intelligenceRank, 1, opts.sizeLabel, opts.budget);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(opts.platform, opts.modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, opts.priority);
  // every platform needs at least one healthy key to be routable
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(opts.platform);
  return id;
}

// Insert N request rows (now → age 0, decay weight 1) for stats.
function addHistory(platform: string, modelId: string, opts: {
  successes: number; failures: number; outTokens?: number; latencyMs?: number; ttfbMs?: number | null;
}) {
  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?)
  `);
  for (let i = 0; i < opts.successes; i++) {
    ins.run(platform, modelId, 'success', opts.outTokens ?? 100, opts.latencyMs ?? 1000, null, opts.ttfbMs ?? null);
  }
  for (let i = 0; i < opts.failures; i++) {
    ins.run(platform, modelId, 'error', 0, opts.latencyMs ?? 1000, 'boom', opts.ttfbMs ?? null);
  }
}

function pickCounts(runs: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const r = routeRequest(100);
    counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
  }
  return counts;
}

describe('bandit router', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    // initDb seeds the real catalog; wipe it so each test controls its own
    // models/keys/history (and seeded models don't share a platform with ours).
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('strategy persists to and from settings; defaults to balanced', () => {
    expect(getRoutingStrategy()).toBe('balanced');
    setRoutingStrategy('smartest');
    expect(getRoutingStrategy()).toBe('smartest');
    setRoutingStrategy('priority');
    expect(getRoutingStrategy()).toBe('priority');
  });

  it('priority strategy follows the manual chain order deterministically', () => {
    addModel({ platform: 'google', modelId: 'a', name: 'A', intelligenceRank: 9, sizeLabel: 'Small', budget: '~10M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'b', name: 'B', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~10M', priority: 2 });
    setRoutingStrategy('priority');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(50);
    expect(counts['a']).toBe(50); // priority 1 always wins regardless of intelligence
  });

  it('balanced strategy favors the more reliable model', () => {
    addModel({ platform: 'google', modelId: 'good', name: 'Good', intelligenceRank: 3, sizeLabel: 'Large', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'flaky', name: 'Flaky', intelligenceRank: 3, sizeLabel: 'Large', budget: '~50M', priority: 2 });
    addHistory('google', 'good', { successes: 60, failures: 1 });
    addHistory('groq', 'flaky', { successes: 5, failures: 40 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(300);
    expect(counts['good'] ?? 0).toBeGreaterThan((counts['flaky'] ?? 0) * 3);
  });

  it('explores unseen models — both get picked at least once', () => {
    addModel({ platform: 'google', modelId: 'x', name: 'X', intelligenceRank: 3, sizeLabel: 'Large', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'y', name: 'Y', intelligenceRank: 3, sizeLabel: 'Large', budget: '~50M', priority: 2 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(200);
    expect(counts['x'] ?? 0).toBeGreaterThan(0);
    expect(counts['y'] ?? 0).toBeGreaterThan(0);
  });

  it('smartest vs fastest flips which model wins, at equal reliability', () => {
    // Smart: frontier tier, slow. Fast: small tier, high throughput. Equal success.
    addModel({ platform: 'google', modelId: 'smart', name: 'Smart', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'fast', name: 'Fast', intelligenceRank: 9, sizeLabel: 'Small', budget: '~50M', priority: 2 });
    addHistory('google', 'smart', { successes: 40, failures: 1, outTokens: 100, latencyMs: 3000, ttfbMs: 2500 });
    addHistory('groq', 'fast', { successes: 40, failures: 1, outTokens: 1000, latencyMs: 1000, ttfbMs: 150 });

    setRoutingStrategy('smartest');
    refreshStatsCache(getDb(), true);
    const smartRun = pickCounts(300);
    expect((smartRun['smart'] ?? 0)).toBeGreaterThan(smartRun['fast'] ?? 0);

    setRoutingStrategy('fastest');
    refreshStatsCache(getDb(), true);
    const fastRun = pickCounts(300);
    expect((fastRun['fast'] ?? 0)).toBeGreaterThan(fastRun['smart'] ?? 0);
  });

  it('getRoutingScores returns a per-axis breakdown ranked by score', () => {
    addModel({ platform: 'google', modelId: 'm1', name: 'M1', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addHistory('google', 'm1', { successes: 30, failures: 0, outTokens: 500, latencyMs: 1000, ttfbMs: 200 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const { strategy, weights, scores } = getRoutingScores();
    expect(strategy).toBe('balanced');
    expect(weights).toEqual({ reliability: 0.5, speed: 0.25, intelligence: 0.25 });
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ modelId: 'm1', enabled: true });
    expect(scores[0].reliability).toBeGreaterThan(0.9);
    expect(scores[0].score).toBeGreaterThan(0);
    expect(scores[0].score).toBeLessThanOrEqual(1);
  });
});
