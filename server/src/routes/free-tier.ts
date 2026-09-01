import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { parseBudget } from '../lib/budget.js';
import { getActiveProfileId } from '../services/profile-models.js';
import { inferQuotaPoolKey, getQuotaStateForKeys } from '../services/provider-quota.js';
import type { Platform, QuotaMetric } from '@freellmapi/shared/types.js';

/**
 * Free-tier budget dashboard (#905).
 *
 * Pool-deduped monthly budget overview: the models table carries per-model
 * labels like '~120M' / '~3M (1k credits)' / 'credits-based'; many models on
 * one platform share the same free pool (see inferQuotaPoolKey), so summing
 * every model's label would double-count. We take ONE documented budget per
 * pool (the largest parseBudget value seen in it) and report the pools
 * alongside live quota observations (used/remaining/reset) when the provider
 * reports them.
 *
 * The model set, the key-count scaling and the enabled semantics deliberately
 * match GET /api/fallback/token-usage (the stacked bar whose legend these pools
 * group), so the two never disagree about the same pool:
 *   - only platforms that actually have an enabled key are counted;
 *   - a documented budget is per account, so it is scaled by the usable
 *     (enabled + healthy/unknown) key count for the platform;
 *   - chain-disabled rows still contribute to the pool (they share the same
 *     provider allowance) and are only marked, never dropped.
 */

export const freeTierRouter = Router();

interface PoolAgg {
  poolKey: string;
  platform: string;
  // Which chain models this pool holds, as their provider model ids. The
  // dashboard legend lists models, not pools, so it needs this to put each
  // model row under its own pool header; without it the client would have to
  // re-implement inferQuotaPoolKey (which is provider knowledge that lives
  // here). Ordered as the chain returns them.
  memberModelIds: string[];
  modelCount: number;
  disabledModelCount: number;
  keyCount: number;
  documentedBudget: number;
  bestLabel: string;
  kind: 'documented' | 'credits' | 'unpublished';
}

interface PoolQuota {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  metric: QuotaMetric;
  keyCount: number;
}

// Which metric best describes a pool's headroom. A 429 or a Retry-After writes
// a `requests` row with remaining=0, and it is almost always the newest row in
// the pool — so "latest observation wins" would report a request counter (or a
// hard 0) under a column the user reads as tokens. Prefer the metric that
// actually measures the budget, and fall back only when nothing better exists.
const METRIC_PREFERENCE: QuotaMetric[] = ['tokens', 'credits', 'neurons', 'requests'];

/**
 * Collapse the per-(key, metric) quota rows of one pool into a single reading.
 * A pool is an allowance per provider account, so N keys on the platform mean N
 * separate allowances: remaining/limit are SUMMED across keys, never
 * latest-wins (which reported one account's headroom as if it were the total).
 */
function summarizeQuota(rows: ReturnType<typeof getQuotaStateForKeys>): PoolQuota | null {
  if (rows.length === 0) return null;
  const byMetric = new Map<QuotaMetric, typeof rows>();
  for (const row of rows) {
    const list = byMetric.get(row.metric);
    if (list) list.push(row);
    else byMetric.set(row.metric, [row]);
  }
  let metric = METRIC_PREFERENCE.find(m => byMetric.has(m));
  if (!metric) {
    // Unknown metric name (a newer provider, an older row): take the freshest.
    metric = [...byMetric.keys()].sort((a, b) => {
      const at = byMetric.get(a)!.reduce((s, r) => (r.observedAt > s ? r.observedAt : s), '');
      const bt = byMetric.get(b)!.reduce((s, r) => (r.observedAt > s ? r.observedAt : s), '');
      return bt.localeCompare(at);
    })[0];
  }
  const chosen = byMetric.get(metric)!;

  // One row per key (getQuotaStateForKeys is keyed by platform+key+pool+metric).
  const seenKeys = new Set<number>();
  let limit: number | null = null;
  let remaining: number | null = null;
  let resetAt: string | null = null;
  for (const row of chosen) {
    if (seenKeys.has(row.keyId)) continue;
    seenKeys.add(row.keyId);
    if (typeof row.limit === 'number') limit = (limit ?? 0) + row.limit;
    if (typeof row.remaining === 'number') remaining = (remaining ?? 0) + row.remaining;
    // The soonest reset is the one worth showing: it is when the pool next
    // gains headroom.
    if (row.resetAt && (resetAt === null || row.resetAt < resetAt)) resetAt = row.resetAt;
  }
  return { limit, remaining, resetAt, metric, keyCount: seenKeys.size };
}

freeTierRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  // Only platforms with an enabled key have a free tier to speak of — same
  // filter the stacked bar uses for its per-model breakdown.
  const platformSet = new Set(
    (db.prepare('SELECT DISTINCT platform FROM api_keys WHERE enabled = 1').all() as { platform: string }[])
      .map(p => p.platform),
  );
  // Usable keys per platform: a documented budget is per account, so two usable
  // accounts really are twice the pool (fallback.ts uses the same filter).
  const keyCountMap = new Map(
    (db.prepare("SELECT platform, COUNT(*) as count FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform").all() as { platform: string; count: number }[])
      .map(k => [k.platform, k.count]),
  );

  // Chain membership mirrors /token-usage: the active profile's chain when one
  // is active, the default fallback chain otherwise. `chain_enabled` is only a
  // marker — a switched-off row still consumes the same provider allowance.
  const activeProfileId = getActiveProfileId(db);
  const rows = (activeProfileId
    ? db.prepare(`
        SELECT m.platform, m.model_id, m.monthly_token_budget, pm.enabled AS chain_enabled
        FROM profile_models pm
        JOIN models m ON m.id = pm.model_db_id
        WHERE pm.profile_id = ? AND m.enabled = 1
      `).all(activeProfileId)
    : db.prepare(`
        SELECT m.platform, m.model_id, m.monthly_token_budget, COALESCE(fc.enabled, 1) AS chain_enabled
        FROM models m
        LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
        WHERE m.enabled = 1
      `).all()) as { platform: string; model_id: string; monthly_token_budget: string; chain_enabled: number }[];

  const pools = new Map<string, PoolAgg>();
  for (const row of rows) {
    if (!platformSet.has(row.platform)) continue;
    const poolKey = inferQuotaPoolKey(row.platform as Platform, row.model_id);
    const label = row.monthly_token_budget ?? '';
    const budget = parseBudget(label);
    let p = pools.get(poolKey);
    if (!p) {
      p = {
        poolKey,
        platform: row.platform,
        memberModelIds: [],
        modelCount: 0,
        disabledModelCount: 0,
        keyCount: keyCountMap.get(row.platform) ?? 0,
        documentedBudget: 0,
        bestLabel: label,
        kind: 'unpublished',
      };
      pools.set(poolKey, p);
    }
    p.memberModelIds.push(row.model_id);
    p.modelCount += 1;
    if (row.chain_enabled === 0) p.disabledModelCount += 1;
    // One budget per pool: keep the largest documented value.
    if (budget > p.documentedBudget) {
      p.documentedBudget = budget;
      p.bestLabel = label;
    }
    if (p.kind !== 'documented') {
      if (budget > 0) p.kind = 'documented';
      else if (/credit/i.test(label)) p.kind = 'credits';
    }
  }

  // Quota observations grouped per pool, then reduced per pool (see above).
  const quotaRows = new Map<string, ReturnType<typeof getQuotaStateForKeys>>();
  for (const q of getQuotaStateForKeys()) {
    const key = q.quotaPoolKey || `${q.platform}::account`;
    const list = quotaRows.get(key);
    if (list) list.push(q);
    else quotaRows.set(key, [q]);
  }

  const poolList = [...pools.values()].map(p => ({
    ...p,
    // Pooled capacity, scaled the same way the model rows and the stacked bar
    // are (fallback.ts): one documented allowance per usable account.
    documentedBudget: p.documentedBudget * Math.max(1, p.keyCount),
  })).sort((a, b) => b.documentedBudget - a.documentedBudget || a.poolKey.localeCompare(b.poolKey));

  const summary = {
    poolCount: poolList.length,
    documentedMonthlyTokens: poolList
      .filter(p => p.kind === 'documented')
      .reduce((s, p) => s + p.documentedBudget, 0),
    creditsBasedPools: poolList.filter(p => p.kind === 'credits').length,
    unpublishedPools: poolList.filter(p => p.kind === 'unpublished').length,
  };

  res.json({
    generatedAt: new Date().toISOString(),
    summary,
    pools: poolList.map(p => ({ ...p, quota: summarizeQuota(quotaRows.get(p.poolKey) ?? []) })),
  });
});
