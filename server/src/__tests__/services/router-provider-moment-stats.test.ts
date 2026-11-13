import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  getRoutingScores, refreshStatsCache, setProviderMomentAttribution,
} from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';

// #1347 (PR 1): rows tagged 'provider_moment' are the provider's bad minute,
// not the model — with attribution ON they drop out of the reliability stats
// (denominator, failures, timeouts, speed). With it OFF (the default) every
// row counts and scoring is byte-identical to today.
function addModel(platform: string, modelId: string): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 3, 1, 'Large', '~50M', 1, 0, 1)
  `).run(platform, modelId, modelId.toUpperCase());
  return (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number }).id;
}

function scoreFor(modelDbId: number) {
  return getRoutingScores().scores.find(s => s.modelDbId === modelDbId);
}

// 1 success, 1 ordinary failure, 1 attributed provider-moment failure —
// all logged this instant, so the day-0 decay weight is 1 for each.
function seed() {
  logRequest('groq', 'test-model', null, 'success', 100, 50, 12, null);
  logRequest('groq', 'test-model', null, 'error', 30, 0, 9, 'API error 500: boom');
  logRequest('groq', 'test-model', null, 'error', 30, 0, 9, 'API error 429: rate limit', null, null, null, null, 'provider_moment');
}

describe('provider-moment rows in the reliability stats (#1347 PR 1)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    delete process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION;
    // Drop our rows only (requests first: they reference the model): the
    // seeded catalog's fallback_config rows would fail the FK on a blanket
    // DELETE FROM models.
    getDb().prepare('DELETE FROM requests').run();
    const mine = getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get('groq', 'test-model') as { id: number } | undefined;
    if (mine) getDb().prepare('DELETE FROM models WHERE id = ?').run(mine.id);
    setProviderMomentAttribution(false);
  });

  it('feature OFF (default): every row counts, exactly as today', () => {
    const id = addModel('groq', 'test-model');
    seed();
    refreshStatsCache(getDb(), true);

    const score = scoreFor(id);
    expect(score).toBeDefined();
    expect(score!.totalRequests).toBe(3);
    expect(score!.reliability).toBeLessThan(1);
  });

  it('feature ON: attributed rows drop out of the model books', () => {
    const id = addModel('groq', 'test-model');
    seed();
    refreshStatsCache(getDb(), true);
    const off = scoreFor(id);

    setProviderMomentAttribution(true); // force-refreshes the stats cache
    const on = scoreFor(id);

    expect(on!.totalRequests).toBe(2);
    expect(on!.reliability).toBeGreaterThan(off!.reliability);
  });
});
