import { describe, it, expect } from 'vitest'
import { buildLegendGroups, isPerModelPool, poolScopeWords, type FreeTierPool, type LegendRow } from './pool-legend'

function row(platform: string, modelId: string, budget: number, used = 0): LegendRow {
  return {
    displayName: `${platform}/${modelId}`,
    platform,
    modelId,
    budget,
    used,
    usedTokens: used,
    remainingTokens: Math.max(0, budget - used),
    widthPct: 0,
  }
}

function pool(over: Partial<FreeTierPool> & Pick<FreeTierPool, 'poolKey' | 'platform' | 'memberModelIds'>): FreeTierPool {
  return {
    modelCount: over.memberModelIds.length,
    disabledModelCount: 0,
    keyCount: 1,
    documentedBudget: 0,
    bestLabel: '',
    kind: 'documented',
    quota: null,
    ...over,
  }
}

describe('pool scope wording', () => {
  it('reads the scope out of a pool key', () => {
    expect(poolScopeWords('groq::account')).toBe('account')
    expect(poolScopeWords('openrouter::free')).toBe('free')
  })

  it('drops a scope that would only repeat the word "pool"', () => {
    // "nvidia · shared credit pool pool" helps nobody.
    expect(poolScopeWords('nvidia::credit-pool')).toBe('credit')
    expect(poolScopeWords('mistral::experiment-pool')).toBe('experiment')
    expect(poolScopeWords('cerebras::shared')).toBe('')
  })
})

describe('per-model pools', () => {
  it('recognises a pool that is really just one model', () => {
    expect(isPerModelPool(pool({ poolKey: 'custom::llama-3', platform: 'custom', memberModelIds: ['llama-3'] }))).toBe(true)
    expect(isPerModelPool(pool({ poolKey: 'groq::account', platform: 'groq', memberModelIds: ['llama-3'] }))).toBe(false)
  })
})

describe('legend grouping', () => {
  const groq = pool({
    poolKey: 'groq::account',
    platform: 'groq',
    memberModelIds: ['a', 'b'],
    documentedBudget: 15_000_000,
    disabledModelCount: 1,
  })
  const solo = pool({ poolKey: 'custom::c', platform: 'custom', memberModelIds: ['c'], documentedBudget: 1_000 })

  it('nests each model under the pool that names it', () => {
    const { groups, rowCount } = buildLegendGroups(
      [row('groq', 'a', 10), row('groq', 'b', 20), row('custom', 'c', 30)],
      [groq, solo],
    )
    expect(groups.map(g => g.pool?.poolKey ?? null)).toEqual(['groq::account', null])
    expect(groups[0].models.map(m => m.modelId)).toEqual(['a', 'b'])
    // A one-model pool is not worth a header of its own; it lands in the
    // trailing independent group.
    expect(groups[1].models.map(m => m.modelId)).toEqual(['c'])
    expect(rowCount).toBe(3)
  })

  it('folds models with no published budget into the count, as the flat legend did', () => {
    const { groups, unpublishedCount, rowCount } = buildLegendGroups(
      [row('groq', 'a', 10), row('groq', 'b', 0)],
      [groq],
    )
    expect(unpublishedCount).toBe(1)
    expect(rowCount).toBe(1)
    expect(groups[0].models.map(m => m.modelId)).toEqual(['a'])
  })

  it('keeps a header for a pool whose only numbers are live ones', () => {
    const live = pool({
      poolKey: 'kilo::anonymous',
      platform: 'kilo',
      memberModelIds: ['k'],
      documentedBudget: 0,
      kind: 'unpublished',
      quota: { limit: null, remaining: 40, resetAt: null, metric: 'requests', keyCount: 1 },
    })
    const { groups, unpublishedCount } = buildLegendGroups([row('kilo', 'k', 0)], [live])
    expect(groups).toHaveLength(1)
    expect(groups[0].models).toHaveLength(0)
    expect(unpublishedCount).toBe(1)
  })

  it('drops a pool that publishes nothing and reports nothing', () => {
    const silent = pool({
      poolKey: 'llm7::anonymous',
      platform: 'llm7',
      memberModelIds: ['x'],
      documentedBudget: 0,
      kind: 'unpublished',
    })
    const { groups, unpublishedCount } = buildLegendGroups([row('llm7', 'x', 0)], [silent])
    expect(groups).toHaveLength(0)
    expect(unpublishedCount).toBe(1)
  })

  it('falls back to one flat group before the pools have loaded', () => {
    const { groups, unpublishedCount, rowCount } = buildLegendGroups(
      [row('groq', 'a', 10), row('groq', 'b', 0)],
      undefined,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].pool).toBeNull()
    expect(rowCount).toBe(1)
    expect(unpublishedCount).toBe(1)
  })

  it('orders pools the way the server sent them and puts loose models last', () => {
    const small = pool({ poolKey: 'kilo::anonymous', platform: 'kilo', memberModelIds: ['k'], documentedBudget: 5 })
    const { groups } = buildLegendGroups(
      [row('custom', 'c', 30), row('kilo', 'k', 5), row('groq', 'a', 10)],
      [groq, small, solo],
    )
    expect(groups.map(g => g.pool?.poolKey ?? 'independent')).toEqual([
      'groq::account',
      'kilo::anonymous',
      'independent',
    ])
  })
})
