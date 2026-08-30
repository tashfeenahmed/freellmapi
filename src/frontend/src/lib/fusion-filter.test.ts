import { describe, expect, it } from 'vitest'
import { filterFusionModels, fusionProviders } from './fusion-filter'
import type { ModelOption } from './model-groups'

const opt = (value: string, label: string, platform: string, platforms: string[] = [platform]): ModelOption => ({
  value,
  label,
  platform,
  platforms,
  providerCount: platforms.length,
  sizeTier: 3,
  intelligenceRank: 50,
})

const options: ModelOption[] = [
  opt('gpt-4.1', 'GPT-4.1', 'OpenAI', ['OpenAI']),
  opt('claude-sonnet-4', 'Claude Sonnet 4', 'Anthropic', ['Anthropic']),
  opt('deepseek-v3', 'DeepSeek V3', 'DeepSeek', ['DeepSeek', 'NVIDIA']),
]

describe('filterFusionModels (#872)', () => {
  it('keeps everything when query and provider are empty', () => {
    expect(filterFusionModels(options, '', null)).toHaveLength(3)
  })

  it('matches a case-insensitive substring on the display name', () => {
    expect(filterFusionModels(options, 'claude', null).map(o => o.value)).toEqual(['claude-sonnet-4'])
  })

  it('matches on the canonical id', () => {
    expect(filterFusionModels(options, 'deepseek-v3', null).map(o => o.value)).toEqual(['deepseek-v3'])
  })

  it('filters to a single provider', () => {
    expect(filterFusionModels(options, '', 'OpenAI').map(o => o.value)).toEqual(['gpt-4.1'])
  })

  it('keeps multi-provider rows when any listed provider matches', () => {
    expect(filterFusionModels(options, '', 'NVIDIA').map(o => o.value)).toEqual(['deepseek-v3'])
  })

  it('combines query and provider filters', () => {
    expect(filterFusionModels(options, 'v3', 'DeepSeek').map(o => o.value)).toEqual(['deepseek-v3'])
    expect(filterFusionModels(options, 'claude', 'OpenAI')).toHaveLength(0)
  })

  it('trims the query', () => {
    expect(filterFusionModels(options, '  sonnet  ', null).map(o => o.value)).toEqual(['claude-sonnet-4'])
  })
})

describe('fusionProviders (#872)', () => {
  it('collects and sorts every distinct provider name', () => {
    expect(fusionProviders(options)).toEqual(['Anthropic', 'DeepSeek', 'NVIDIA', 'OpenAI'])
  })
})
