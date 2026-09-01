import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeRequest, refreshStatsCache, setRoutingStrategy } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';
import { addToActiveChain } from '../helpers/chain.js';

// Per-key scoring inside one model (#580): with the group merge, several keys
// (and formerly several providers' identically-named models) share one routing
// bucket. Key selection must not be blind round-robin — a key with a bad track
// record (expired, quota-drained, region-blocked) should be picked less than a
// healthy sibling, while a brand-new key still gets explored.

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

// Insert a model + fallback entry (no key — keys are added separately).
function addModel(opts: {
  platform: string; modelId: string; name: string; priority?: number;
}): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
    VALUES (?, ?, ?, 3, 1, 'Large', '~50M', 1)
  `).run(opts.platform, opts.modelId, opts.name);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(opts.platform, opts.modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, opts.priority ?? 1);
  addToActiveChain(id, opts.priority ?? 1);
  return id;
}

function addKey(platform: string, label: string): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(platform, label);
  return Number((db.prepare('SELECT id FROM api_keys WHERE platform = ? AND label = ?')
    .get(platform, label) as { id: number }).id);
}

// Insert request rows attributed to a SPECIFIC key (now → age 0, weight 1).
function addKeyHistory(platform: string, modelId: string, keyId: number, opts: {
  successes: number; failures: number; outTokens?: number; latencyMs?: number;
}) {
  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)
  `);
  for (let i = 0; i < opts.successes; i++) {
    ins.run(platform, modelId, keyId, 'success', opts.outTokens ?? 100, opts.latencyMs ?? 1000, null);
  }
  for (let i = 0; i < opts.failures; i++) {
    ins.run(platform, modelId, keyId, 'error', 0, opts.latencyMs ?? 1000, 'boom');
  }
}

function pickKeyCounts(runs: number): Record<number, number> {
  const counts: Record<number, number> = {};
  for (let i = 0; i < runs; i++) {
    const r = routeRequest(100);
    counts[r.keyId] = (counts[r.keyId] ?? 0) + 1;
    r.release();
  }
  return counts;
}

describe('per-key bandit selection', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);
    setRoutingStrategy('balanced');
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('prefers the key with the better recorded success rate', () => {
    addModel({ platform: 'groq', modelId: 'm', name: 'M' });
    const good = addKey('groq', 'good');
    const bad = addKey('groq', 'bad');
    addKeyHistory('groq', 'm', good, { successes: 50, failures: 1 });
    addKeyHistory('groq', 'm', bad, { successes: 4, failures: 40 });
    refreshStatsCache(getDb(), true);

    const counts = pickKeyCounts(300);
    expect(counts[good] ?? 0).toBeGreaterThan((counts[bad] ?? 0) * 3);
  });

  it('still explores a key with no recorded data', () => {
    addModel({ platform: 'groq', modelId: 'm', name: 'M' });
    const seasoned = addKey('groq', 'seasoned');
    const fresh = addKey('groq', 'fresh');
    addKeyHistory('groq', 'm', seasoned, { successes: 40, failures: 2 });
    refreshStatsCache(getDb(), true);

    // Thompson sampling gives an unmeasured key a small but non-zero chance of
    // winning each draw (~1.5% with this prior), so 300 draws flaked in CI when
    // the fresh key lost every one. 3000 draws make that ~1e-20 instead.
    const counts = pickKeyCounts(3000);
    expect(counts[fresh] ?? 0).toBeGreaterThan(0);
    expect(counts[seasoned] ?? 0).toBeGreaterThan(0);
  });

  it('cooldown still excludes a key regardless of its score', () => {
    addModel({ platform: 'groq', modelId: 'm', name: 'M' });
    const good = addKey('groq', 'good');
    const other = addKey('groq', 'other');
    addKeyHistory('groq', 'm', good, { successes: 50, failures: 0 });
    addKeyHistory('groq', 'm', other, { successes: 5, failures: 20 });
    refreshStatsCache(getDb(), true);

    (ratelimit.isOnCooldown as any).mockImplementation(
      (_p: string, _m: string, keyId: number) => keyId === good,
    );
    const counts = pickKeyCounts(50);
    expect(counts[good] ?? 0).toBe(0);
    expect(counts[other]).toBe(50);
  });

  it('a single-key model always routes to that key', () => {
    addModel({ platform: 'groq', modelId: 'm', name: 'M' });
    const only = addKey('groq', 'only');
    addKeyHistory('groq', 'm', only, { successes: 3, failures: 30 });
    refreshStatsCache(getDb(), true);

    const counts = pickKeyCounts(30);
    expect(counts[only]).toBe(30);
  });

  it('with no data on any key, falls back to round-robin rotation', () => {
    addModel({ platform: 'groq', modelId: 'm', name: 'M' });
    const a = addKey('groq', 'a');
    const b = addKey('groq', 'b');
    refreshStatsCache(getDb(), true);

    const counts = pickKeyCounts(40);
    expect(counts[a]).toBe(20);
    expect(counts[b]).toBe(20);
  });
});
