import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

let dashToken = '';

async function get(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: { Authorization: `Bearer ${dashToken}` },
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

function insertKey(platform: string, label: string): number {
  const db = getDb();
  const enc = encrypt(`${platform}-${label}`);
  const info = db.prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?,?,?,?,?,'healthy',1)",
  ).run(platform, label, enc.encrypted, enc.iv, enc.authTag);
  return Number(info.lastInsertRowid);
}

function future(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function observe(row: {
  platform: string; keyId: number; pool: string; metric: string;
  limit: number | null; remaining: number | null; resetAt: string | null; observedAt: string;
}) {
  getDb().prepare(`
    INSERT INTO provider_quota_state
      (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, reset_strategy, source, confidence, observed_at, updated_at)
    VALUES (?,?,?,?,?,?,?, 'provider_reported', 'header', 1, ?, ?)
  `).run(row.platform, row.keyId, row.pool, row.metric, row.limit, row.remaining, row.resetAt, row.observedAt, row.observedAt);
}

// GET /api/free-tier reports one budget per provider pool (#905). The pools it
// reports group the per-model legend under the stacked token bar, so it
// has to agree with /api/fallback/token-usage about key scaling and about which
// models are in play, and it must never present a request counter as if it were
// a token budget.
describe('free-tier pool overview (#905)', () => {
  let app: Express;
  let groqKey = 0;
  let cerebrasA = 0;
  let cerebrasB = 0;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    const db = getDb();

    // Narrow the catalog down to a handful of rows across three platforms.
    db.prepare('UPDATE models SET enabled = 0').run();
    const groq = db.prepare("SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 3").all() as { id: number; model_id: string }[];
    const cerebras = db.prepare("SELECT id FROM models WHERE platform = 'cerebras' ORDER BY id LIMIT 2").all() as { id: number }[];
    const google = db.prepare("SELECT id FROM models WHERE platform = 'google' ORDER BY id LIMIT 1").all() as { id: number }[];
    const on = db.prepare('UPDATE models SET enabled = 1 WHERE id = ?');
    for (const m of [...groq, ...cerebras, ...google]) on.run(m.id);

    // Three groq models in ONE pool with different labels: the pool takes the
    // largest documented budget once, never the sum of the three.
    const budget = db.prepare('UPDATE models SET monthly_token_budget = ? WHERE id = ?');
    budget.run('~6M', groq[0].id);
    budget.run('~15M', groq[1].id);
    budget.run('~6M', groq[2].id);
    budget.run('~30M', cerebras[0].id);
    budget.run('credits-based', cerebras[1].id);
    budget.run('~3M', google[0].id);

    // One groq row is switched off in the chain: it still shares the provider
    // allowance, so it stays in the pool and is only marked.
    // (initDb activates a Default profile, so the chain in play is
    // profile_models; keep both in sync the way the dashboard does.)
    db.prepare('UPDATE fallback_config SET enabled = 1').run();
    db.prepare('UPDATE profile_models SET enabled = 1').run();
    db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(groq[2].id);
    db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(groq[2].id);

    groqKey = insertKey('groq', 'groq-main');
    cerebrasA = insertKey('cerebras', 'cerebras-a');
    cerebrasB = insertKey('cerebras', 'cerebras-b');
    // google is deliberately left keyless.

    // groq: an older `tokens` reading and a newer `requests` one (a 429 writes
    // exactly this). Latest-wins would report 5,000 requests as the headroom.
    observe({ platform: 'groq', keyId: groqKey, pool: 'groq::account', metric: 'tokens', limit: 15_000_000, remaining: 12_400_000, resetAt: future(600), observedAt: '2026-01-01 00:00:00' });
    observe({ platform: 'groq', keyId: groqKey, pool: 'groq::account', metric: 'requests', limit: 14_400, remaining: 5_000, resetAt: future(120), observedAt: '2026-01-02 00:00:00' });
    // cerebras: the same pool seen through two keys — two accounts, two allowances.
    observe({ platform: 'cerebras', keyId: cerebrasA, pool: 'cerebras::shared', metric: 'tokens', limit: 30_000_000, remaining: 20_000_000, resetAt: future(300), observedAt: '2026-01-01 00:00:00' });
    observe({ platform: 'cerebras', keyId: cerebrasB, pool: 'cerebras::shared', metric: 'tokens', limit: 30_000_000, remaining: 8_000_000, resetAt: future(180), observedAt: '2026-01-03 00:00:00' });
  });

  it('reports one row per pool with a single deduped budget', async () => {
    const { status, body } = await get(app, '/api/free-tier');
    expect(status).toBe(200);

    const groq = body.pools.find((p: any) => p.poolKey === 'groq::account');
    expect(groq).toBeDefined();
    // Three models, ONE budget: the largest label in the pool (~15M), scaled by
    // the single usable key — not 6M + 15M + 6M.
    expect(groq.modelCount).toBe(3);
    expect(groq.documentedBudget).toBe(15_000_000);
    expect(body.summary.poolCount).toBe(body.pools.length);
  });

  it('scales a pool by the usable key count, like the stacked bar does', async () => {
    const { body } = await get(app, '/api/free-tier');
    const cerebras = body.pools.find((p: any) => p.poolKey === 'cerebras::shared');
    // Two healthy keys = two accounts = twice the documented ~30M allowance.
    expect(cerebras.keyCount).toBe(2);
    expect(cerebras.documentedBudget).toBe(60_000_000);
    expect(body.summary.documentedMonthlyTokens).toBe(60_000_000 + 15_000_000);
  });

  it('prefers the tokens observation over a newer requests one and always names the metric', async () => {
    const { body } = await get(app, '/api/free-tier');
    const groq = body.pools.find((p: any) => p.poolKey === 'groq::account');
    expect(groq.quota.metric).toBe('tokens');
    expect(groq.quota.remaining).toBe(12_400_000);
    expect(groq.quota.limit).toBe(15_000_000);
    // Every pool that reports anything says which budget the number counts.
    for (const pool of body.pools) {
      if (pool.quota) expect(typeof pool.quota.metric).toBe('string');
    }
  });

  it('sums remaining across the keys sharing a pool instead of taking the latest', async () => {
    const { body } = await get(app, '/api/free-tier');
    const cerebras = body.pools.find((p: any) => p.poolKey === 'cerebras::shared');
    expect(cerebras.quota.metric).toBe('tokens');
    // 20M on one account + 8M on the other; latest-wins reported only 8M.
    expect(cerebras.quota.remaining).toBe(28_000_000);
    expect(cerebras.quota.limit).toBe(60_000_000);
    expect(cerebras.quota.keyCount).toBe(2);
  });

  it('keeps chain-disabled rows in the pool but marks them', async () => {
    const { body } = await get(app, '/api/free-tier');
    const groq = body.pools.find((p: any) => p.poolKey === 'groq::account');
    expect(groq.modelCount).toBe(3);
    expect(groq.disabledModelCount).toBe(1);
    // The disabled row does not reduce the pool's documented budget.
    expect(groq.documentedBudget).toBe(15_000_000);
  });

  it('names the models in each pool so the legend can group its rows', async () => {
    const { body } = await get(app, '/api/free-tier');
    const groq = body.pools.find((p: any) => p.poolKey === 'groq::account');
    // The legend joins its own per-model rows on platform + model id, so the
    // pool has to name its members; the count has to agree with modelCount, and
    // the chain-disabled row is a member like any other.
    expect(groq.memberModelIds).toHaveLength(groq.modelCount);
    expect(new Set(groq.memberModelIds).size).toBe(groq.modelCount);

    const usage = await get(app, '/api/fallback/token-usage');
    const chainIds = (usage.body.models as any[])
      .filter(m => m.platform === 'groq')
      .map(m => m.modelId)
      .sort();
    expect([...groq.memberModelIds].sort()).toEqual(chainIds);

    // Every model of every pool maps back to exactly one pool: the join the
    // legend does cannot put one row under two headers.
    const seen = new Set<string>();
    for (const pool of body.pools) {
      for (const id of pool.memberModelIds) {
        const qualified = `${pool.platform}::${id}`;
        expect(seen.has(qualified)).toBe(false);
        seen.add(qualified);
      }
    }
  });

  it('classifies a credits-only pool and skips platforms with no key', async () => {
    const { body } = await get(app, '/api/free-tier');
    expect(body.pools.some((p: any) => p.platform === 'google')).toBe(false);
    const cerebras = body.pools.find((p: any) => p.poolKey === 'cerebras::shared');
    // The pool holds one documented and one credits-based model: documented wins.
    expect(cerebras.kind).toBe('documented');
    expect(body.summary.creditsBasedPools + body.summary.unpublishedPools).toBe(
      body.pools.filter((p: any) => p.kind !== 'documented').length,
    );
  });
});
