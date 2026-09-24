import { describe, it, expect } from 'vitest'
import { buildBudgetLegend, sortByIntelligence, type LegendModel } from './budget-legend'

function model(platform: string, modelId: string, intelligenceRank: number | undefined, budget: number, used = 0): LegendModel {
  return { displayName: `${platform}/${modelId}`, platform, modelId, intelligenceRank, budget, used }
}

describe('sortByIntelligence', () => {
  it('orders smartest first regardless of the incoming (chain-priority) order', () => {
    // Chain priority is seeded provider by provider, so the server used to hand
    // the legend groq, groq, google, google… — the "arranged by provider" look.
    const chainOrder = [
      model('groq', 'llama-8b', 40, 1),
      model('groq', 'llama-70b', 12, 1),
      model('google', 'gemini-flash', 8, 1),
      model('google', 'gemma', 30, 1),
      model('cerebras', 'qwen-235b', 5, 1),
    ]
    expect(sortByIntelligence(chainOrder).map(m => m.modelId)).toEqual([
      'qwen-235b', 'gemini-flash', 'llama-70b', 'gemma', 'llama-8b',
    ])
  })

  it('keeps equal ranks in their incoming order and puts unranked rows last', () => {
    const rows = [
      model('a', 'unranked-first', undefined, 1),
      model('b', 'rank3-first', 3, 1),
      model('c', 'rank3-second', 3, 1),
      model('d', 'rank1', 1, 1),
      model('e', 'unranked-second', undefined, 1),
    ]
    expect(sortByIntelligence(rows).map(m => m.modelId)).toEqual([
      'rank1', 'rank3-first', 'rank3-second', 'unranked-first', 'unranked-second',
    ])
  })

  it('does not mutate its input', () => {
    const rows = [model('a', 'x', 2, 1), model('b', 'y', 1, 1)]
    const before = rows.map(m => m.modelId)
    sortByIntelligence(rows)
    expect(rows.map(m => m.modelId)).toEqual(before)
  })
})

describe('buildBudgetLegend', () => {
  it('is one flat list of budgeted models, smartest first, with no provider grouping', () => {
    const legend = buildBudgetLegend([
      model('groq', 'llama-70b', 12, 1_000_000, 250_000),
      model('google', 'gemini-flash', 8, 2_000_000),
      model('groq', 'llama-8b', 40, 500_000),
    ], 3_500_000)
    expect(legend.rows.map(r => r.modelId)).toEqual(['gemini-flash', 'llama-70b', 'llama-8b'])
    // Only model rows — nothing in the shape names a pool or a provider header.
    for (const row of legend.rows) expect(Object.keys(row)).not.toContain('pool')
  })

  it('computes used / remaining / width per row against the whole budget', () => {
    const legend = buildBudgetLegend([model('groq', 'llama-70b', 1, 1_000_000, 250_000)], 4_000_000)
    expect(legend.rows[0]).toMatchObject({ usedTokens: 250_000, remainingTokens: 750_000, widthPct: 18.75 })
  })

  it('folds rows without a published budget into the unpublished count', () => {
    const legend = buildBudgetLegend([
      model('groq', 'llama-70b', 1, 1_000_000),
      model('pollinations', 'openai', 5, 0),
      model('llm7', 'gpt', 9, 0),
    ], 1_000_000)
    expect(legend.rows.map(r => r.modelId)).toEqual(['llama-70b'])
    expect(legend.unpublishedCount).toBe(2)
  })

  it('never divides by a zero budget', () => {
    const legend = buildBudgetLegend([model('groq', 'x', 1, 10)], 0)
    expect(legend.rows[0].widthPct).toBe(0)
  })
})
