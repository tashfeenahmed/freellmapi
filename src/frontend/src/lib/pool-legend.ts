// Grouping for the token-bar legend: which quota pool each model row belongs
// to (#907 + #1005 merged into one list).
//
// The stacked bar's legend lists models; GET /api/free-tier lists the provider
// pools those models draw from. They used to be two separate accordions saying
// related things about the same numbers, so the legend now nests its model rows
// under their pool. The join is platform + provider model id, which is what
// both payloads carry per model — the pool key itself is provider knowledge
// (see inferQuotaPoolKey on the server) and is deliberately NOT re-derived here.

import type { TokenUsageData } from './routing'

export type PoolKind = 'documented' | 'credits' | 'unpublished'

export interface FreeTierPool {
  poolKey: string
  platform: string
  memberModelIds: string[]
  modelCount: number
  disabledModelCount: number
  keyCount: number
  documentedBudget: number
  bestLabel: string
  kind: PoolKind
  quota: {
    limit: number | null
    remaining: number | null
    resetAt: string | null
    metric: string
    keyCount: number
  } | null
}

export interface FreeTierResponse {
  generatedAt: string
  summary: {
    poolCount: number
    documentedMonthlyTokens: number
    creditsBasedPools: number
    unpublishedPools: number
  }
  pools: FreeTierPool[]
}

export type LegendModel = TokenUsageData['models'][number]

export interface LegendRow extends LegendModel {
  usedTokens: number
  remainingTokens: number
  widthPct: number
}

export interface LegendGroup {
  /** The pool these rows share, or null for the trailing independent-budget
   *  group (models whose "pool" is just themselves). */
  pool: FreeTierPool | null
  models: LegendRow[]
}

export interface LegendGrouping {
  groups: LegendGroup[]
  /** Rows with no budget to show, folded into the "+N with no published quota"
   *  summary line the same way the flat legend folded them. */
  unpublishedCount: number
  /** How many model rows the groups actually render (drives "show all N"). */
  rowCount: number
}

/** A pool of one model is not a pool: the model IS the budget. Those rows read
 *  better ungrouped, so they collect in one trailing group instead of getting a
 *  header each. */
export function isPerModelPool(pool: FreeTierPool): boolean {
  return pool.memberModelIds.some(id => pool.poolKey === `${pool.platform}::${id}`)
}

const scopeSeparator = '::'

/**
 * "groq::account" -> "account", "nvidia::credit-pool" -> "credit",
 * "cerebras::shared" -> "" (nothing left worth saying).
 * The caller turns what comes back into a sentence, so a scope that adds no
 * information comes back empty rather than as a word to repeat.
 */
export function poolScopeWords(poolKey: string): string {
  const index = poolKey.indexOf(scopeSeparator)
  const scope = index === -1 ? '' : poolKey.slice(index + scopeSeparator.length)
  const words = scope.replace(/[-_]+/g, ' ').replace(/\s+pool$/, '').trim()
  return words === 'shared' ? '' : words
}

/**
 * Nest the legend's model rows under their pools.
 *
 * Pool order is the server's (largest documented budget first) so the biggest
 * allowance heads the list; model order inside a group is the chain order the
 * bar itself uses. A pool that publishes nothing AND has no live reading and no
 * budgeted member says nothing a reader can act on, so it folds into the
 * unpublished count instead of taking up a header row.
 */
export function buildLegendGroups(models: LegendRow[], pools: FreeTierPool[] | undefined): LegendGrouping {
  const budgeted = models.filter(m => m.budget > 0)

  if (!pools || pools.length === 0) {
    // No pool data (still loading, or an install with no keys): the flat legend.
    return {
      groups: budgeted.length ? [{ pool: null, models: budgeted }] : [],
      unpublishedCount: models.length - budgeted.length,
      rowCount: budgeted.length,
    }
  }

  const poolByModel = new Map<string, FreeTierPool>()
  for (const pool of pools) {
    for (const id of pool.memberModelIds) poolByModel.set(`${pool.platform}::${id}`, pool)
  }

  const shared = new Map<string, LegendRow[]>()
  const independent: LegendRow[] = []
  let unpublishedCount = 0
  for (const model of models) {
    const pool = model.modelId ? poolByModel.get(`${model.platform}::${model.modelId}`) : undefined
    if (model.budget <= 0) {
      unpublishedCount += 1
      continue
    }
    if (!pool || isPerModelPool(pool)) {
      independent.push(model)
      continue
    }
    const list = shared.get(pool.poolKey)
    if (list) list.push(model)
    else shared.set(pool.poolKey, [model])
  }

  const groups: LegendGroup[] = []
  for (const pool of pools) {
    if (isPerModelPool(pool)) continue
    const rows = shared.get(pool.poolKey) ?? []
    // A live remaining figure or a documented budget is worth a header even
    // when every member model is itself unpublished.
    const worthShowing = rows.length > 0 || pool.documentedBudget > 0 || pool.quota?.remaining != null
    if (worthShowing) groups.push({ pool, models: rows })
  }
  if (independent.length) groups.push({ pool: null, models: independent })

  return {
    groups,
    unpublishedCount,
    rowCount: groups.reduce((sum, g) => sum + g.models.length, 0),
  }
}
