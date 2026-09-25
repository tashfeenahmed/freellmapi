import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  routeRequest, setRoutingStrategy, refreshStatsCache,
} from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';
import { addToActiveChain } from '../helpers/chain.js';
import { reloadRoutingRegistry } from '../../services/router-registry.js';
import * as ratelimit from '../../services/ratelimit.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
    canUseProvider: vi.fn(() => true),
    canUseProviderMinute: vi.fn(() => true),
    canUseProviderTokens: vi.fn(() => true),
    canUseKeyConcurrency: vi.fn(() => true),
  };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

// Same seed shape as router-bandit.test.ts, plus a configurable speed_rank so
// the two fixture models differ on BOTH axes (intelligence and speed).
function addModel(opts: {
  platform: string; modelId: string; name: string;
  intelligenceRank: number; speedRank: number; sizeLabel: string; budget: string; priority: number;
}): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 1)
  `).run(opts.platform, opts.modelId, opts.name, opts.intelligenceRank, opts.speedRank, opts.sizeLabel, opts.budget);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(opts.platform, opts.modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, opts.priority);
  addToActiveChain(id, opts.priority);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(opts.platform);
  return id;
}

function addHistory(platform: string, modelId: string, opts: {
  successes: number; failures: number; outTokens?: number; latencyMs?: number; ttfbMs?: number | null;
}) {
  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, created_at)
    VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?, datetime('now', '-2 hours'))
  `);
  for (let i = 0; i < opts.successes; i++) {
    ins.run(platform, modelId, 'success', opts.outTokens ?? 100, opts.latencyMs ?? 1000, null, opts.ttfbMs ?? null);
  }
  for (let i = 0; i < opts.failures; i++) {
    ins.run(platform, modelId, 'error', 0, opts.latencyMs ?? 1000, 'boom', opts.ttfbMs ?? null);
  }
}

function pickCounts(runs: number, task?: 'code' | 'chat'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const r = routeRequest(100, undefined, undefined, false, false, undefined, undefined, false, undefined, 0, task);
    counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
  }
  return counts;
}

// The intelligence axis is min-max normalized to 1/0 across a two-model chain,
// so the code bias (0.325 intelligence) wins by ~0.15 score over the speed
// axis and the chat bias flips it the other way. Assert DIRECTION (not a fixed
// ratio) with enough runs that the ~55/45 split is well past noise.
const TASK_RUNS = 3000;

// Fixture: A ("smart") is the smarter but much slower model, B ("fast") the
// weaker but blazing-fast one. Equal reliability (all successes) and equal
// budgets, so the only differing axes are intelligence (A > B — rank 1 is the
// catalog's best) and speed (B >> A). The speed gap is intentionally extreme:
// intelligenceScore is min-max normalized across the chain, so with two models
// it is always 1 vs 0, and the speed axis must out-weigh that for the chat
// bias to flip the pick.
async function seedSmartVsFast() {
  addModel({ platform: 'google', modelId: 'smart', name: 'Smart', intelligenceRank: 1, speedRank: 9, sizeLabel: 'Large', budget: '~50M', priority: 1 });
  addModel({ platform: 'groq', modelId: 'fast', name: 'Fast', intelligenceRank: 2, speedRank: 1, sizeLabel: 'Large', budget: '~50M', priority: 2 });
  addHistory('google', 'smart', { successes: 100, failures: 0, outTokens: 1, latencyMs: 60000, ttfbMs: 4999 });
  addHistory('groq', 'fast', { successes: 100, failures: 0, outTokens: 10000, latencyMs: 100, ttfbMs: 10 });
  await reloadRoutingRegistry();
}

describe('task-type-aware routing', () => {
  beforeEach(async () => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    await initDb(':memory:');
    await getDb().query('DELETE FROM credentials');
    await getDb().query('DELETE FROM models');
    await getDb().query('DELETE FROM requests');
    await reloadRoutingRegistry();
    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);

  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('is off by default: no task argument splits the two axes evenly', async () => {
    await seedSmartVsFast();
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(TASK_RUNS);
    // Balanced weights (0.25/0.25) make A and B comparable; neither axis dominates.
    expect(counts['smart'] ?? 0).toBeGreaterThan(0);
    expect(counts['fast'] ?? 0).toBeGreaterThan(0);
  });

  it('code tasks bias toward the smarter (slower) model', async () => {
    await seedSmartVsFast();
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(TASK_RUNS, 'code');
    expect(counts['smart'] ?? 0).toBeGreaterThan(counts['fast'] ?? 0);
  });

  it('chat tasks bias toward the faster (weaker) model', async () => {
    await seedSmartVsFast();
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(TASK_RUNS, 'chat');
    expect(counts['fast'] ?? 0).toBeGreaterThan(counts['smart'] ?? 0);
  });

  async function seedSmartVsFlakyFast() {
    addModel({ platform: 'google', modelId: 'smart', name: 'Smart', intelligenceRank: 1, speedRank: 9, sizeLabel: 'Large', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'fast', name: 'Fast', intelligenceRank: 2, speedRank: 1, sizeLabel: 'Large', budget: '~50M', priority: 2 });
    addHistory('google', 'smart', { successes: 100, failures: 0, outTokens: 1, latencyMs: 60000, ttfbMs: 4999 });
    addHistory('groq', 'fast', { successes: 50, failures: 50, outTokens: 10000, latencyMs: 100, ttfbMs: 10 });
    await reloadRoutingRegistry();
  }

  it('leaves the fastest preset alone on a code task', async () => {
    await seedSmartVsFlakyFast();
    setRoutingStrategy('fastest');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(TASK_RUNS, 'code');
    expect(counts['fast'] ?? 0).toBeGreaterThan(counts['smart'] ?? 0);
  });
});
