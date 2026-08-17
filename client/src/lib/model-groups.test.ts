import { describe, it, expect } from 'vitest'
import { buildModelOptions, sizeTier } from '@/lib/model-groups'
import type { PickerEntry } from '@/lib/model-groups'

describe('sizeTier', () => {
  it('maps known labels to their tier', () => {
    expect(sizeTier('Frontier')).toBe(1)
    expect(sizeTier('Large')).toBe(2)
    expect(sizeTier('Medium')).toBe(3)
    expect(sizeTier('Small')).toBe(4)
  })

  it('returns 5 for unknown / missing labels', () => {
    expect(sizeTier('')).toBe(5)
    expect(sizeTier(undefined)).toBe(5)
    expect(sizeTier('Tiny')).toBe(5)
  })
})

const e = (over: Partial<PickerEntry>): PickerEntry => ({
  modelDbId: 1,
  modelId: 'm1',
  displayName: 'Model 1',
  platform: 'google',
  ...over,
})

describe('buildModelOptions (unify OFF)', () => {
  it('emits one option per provider row', () => {
    const entries = [
      e({ modelId: 'gpt-4o', displayName: 'GPT-4o', platform: 'openai', sizeLabel: 'Large', intelligenceRank: 10 }),
      e({ modelId: 'llama3', displayName: 'Llama 3', platform: 'groq', sizeLabel: 'Medium', intelligenceRank: 40 }),
    ]
    const opts = buildModelOptions(entries, false)
    expect(opts).toHaveLength(2)
    expect(opts[0]).toMatchObject({ value: 'gpt-4o', label: 'GPT-4o', platform: 'openai', providerCount: 1, sizeTier: 2, intelligenceRank: 10 })
  })

  it('defaults missing rank to 999', () => {
    const opts = buildModelOptions([e({ intelligenceRank: undefined })], false)
    expect(opts[0].intelligenceRank).toBe(999)
  })
})

describe('buildModelOptions (unify ON)', () => {
  it('collapses grouped rows into one option per groupKey', () => {
    const entries = [
      e({ modelId: 'gpt-4o-oai', groupKey: 'gpt-4o', canonicalId: 'gpt-4o', groupLabel: 'GPT-4o', platform: 'openai', sizeLabel: 'Large', intelligenceRank: 10 }),
      e({ modelId: 'gpt-4o-groq', groupKey: 'gpt-4o', canonicalId: 'gpt-4o', groupLabel: 'GPT-4o', platform: 'groq', sizeLabel: 'Large', intelligenceRank: 12 }),
    ]
    const opts = buildModelOptions(entries, true)
    expect(opts).toHaveLength(1)
    expect(opts[0]).toMatchObject({ value: 'gpt-4o', label: 'GPT-4o', providerCount: 2, platforms: ['openai', 'groq'] })
  })

  it('takes the best (lowest) size tier and rank across the group', () => {
    const entries = [
      e({ groupKey: 'g', canonicalId: 'g', groupLabel: 'G', platform: 'a', sizeLabel: 'Large', intelligenceRank: 30 }),
      e({ groupKey: 'g', canonicalId: 'g', groupLabel: 'G', platform: 'b', sizeLabel: 'Frontier', intelligenceRank: 5 }),
      e({ groupKey: 'g', canonicalId: 'g', groupLabel: 'G', platform: 'c', sizeLabel: 'Small', intelligenceRank: 50 }),
    ]
    const opt = buildModelOptions(entries, true)[0]
    expect(opt.sizeTier).toBe(1)
    expect(opt.intelligenceRank).toBe(5)
  })

  it('falls back to modelId as the group key for ungrouped rows', () => {
    const opts = buildModelOptions([e({ modelId: 'lonely', groupKey: undefined })], true)
    expect(opts).toHaveLength(1)
    expect(opts[0].value).toBe('lonely')
  })

  it('prefers canonicalId over modelId for the value, groupLabel over displayName for the label', () => {
    const opts = buildModelOptions(
      [e({ modelId: 'raw', canonicalId: 'canon', groupLabel: 'Canon Label', displayName: 'Raw Name' })],
      true,
    )
    expect(opts[0].value).toBe('canon')
    expect(opts[0].label).toBe('Canon Label')
  })

  it('preserves first-seen order across groups', () => {
    const entries = [
      e({ groupKey: 'z', canonicalId: 'z', platform: 'a' }),
      e({ groupKey: 'a', canonicalId: 'a', platform: 'b' }),
      e({ groupKey: 'z', canonicalId: 'z', platform: 'c' }),
    ]
    const opts = buildModelOptions(entries, true)
    expect(opts.map((o) => o.value)).toEqual(['z', 'a'])
  })
})
