import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { parseBudget } from '../lib/budget.js';
import { inferQuotaPoolKey, getQuotaStateForKeys } from '../services/provider-quota.js';
import type { Platform } from '@freellmapi/shared/types.js';

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
 */

export const freeTierRouter = Router();

interface PoolAgg {
  poolKey: string;
  platform: string;
  modelCount: number;
  documentedBudget: number;
  bestLabel: string;
  kind: 'documented' | 'credits' | 'unpublished';
}

freeTierRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT platform, model_id, monthly_token_budget
    FROM models
    WHERE enabled = 1
  `).all() as { platform: string; model_id: string; monthly_token_budget: string }[];

  const pools = new Map<string, PoolAgg>();
  for (const row of rows) {
    const poolKey = inferQuotaPoolKey(row.platform as Platform, row.model_id);
    const label = row.monthly_token_budget ?? '';
    const budget = parseBudget(label);
    let p = pools.get(poolKey);
    if (!p) {
      p = { poolKey, platform: row.platform, modelCount: 0, documentedBudget: 0, bestLabel: label, kind: 'unpublished' };
      pools.set(poolKey, p);
    }
    p.modelCount += 1;
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

  // Latest quota observation per pool (used/remaining/reset), if any.
  const quotaByPool = new Map<string, NonNullable<ReturnType<typeof getQuotaStateForKeys>>[number]>();
  for (const q of getQuotaStateForKeys()) {
    const key = q.quotaPoolKey || `${q.platform}::account`;
    const prev = quotaByPool.get(key);
    if (!prev || (q.observedAt ?? '') >= (prev.observedAt ?? '')) quotaByPool.set(key, q);
  }

  const poolList = [...pools.values()].sort((a, b) => b.documentedBudget - a.documentedBudget);
  const documented = poolList.filter(p => p.kind === 'documented');
  const summary = {
    poolCount: poolList.length,
    documentedMonthlyTokens: documented.reduce((s, p) => s + p.documentedBudget, 0),
    creditsBasedPools: poolList.filter(p => p.kind === 'credits').length,
    unpublishedPools: poolList.filter(p => p.kind === 'unpublished').length,
  };

  res.json({
    generatedAt: new Date().toISOString(),
    summary,
    pools: poolList.map(p => {
      const q = quotaByPool.get(p.poolKey);
      return {
        ...p,
        quota: q
          ? { limit: q.limit, remaining: q.remaining, resetAt: q.resetAt, metric: q.metric }
          : null,
      };
    }),
  });
});
