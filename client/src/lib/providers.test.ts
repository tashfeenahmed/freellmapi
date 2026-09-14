import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ApiKey, Model } from '../../../shared/types'
import {
  calculateProviderHealth,
  groupProviders,
  filterGroupedProviders,
  getHiddenProviders,
  setHiddenProviders,
  getHiddenModels,
  setHiddenModels,
  getCollapsedProviders,
  setCollapsedProviders,
} from './providers'

const mockApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 1,
  platform: 'groq',
  label: 'Groq Primary Key',
  maskedKey: 'gsk_...1234',
  baseUrl: null,
  status: 'healthy',
  enabled: true,
  keyless: false,
  exportable: true,
  createdAt: '2026-09-01T00:00:00Z',
  lastCheckedAt: '2026-09-08T12:00:00Z',
  lastHealthError: null,
  ...overrides,
})

const mockModel = (overrides: Partial<Model> = {}): Model => ({
  id: 101,
  platform: 'groq',
  modelId: 'llama-3.3-70b-versatile',
  displayName: 'Llama 3.3 70B',
  intelligenceRank: 400,
  speedRank: 100,
  sizeLabel: '70B',
  rpmLimit: 30,
  rpdLimit: 14400,
  tpmLimit: 6000,
  tpdLimit: null,
  monthlyTokenBudget: '',
  contextWindow: 128000,
  enabled: true,
  supportsVision: false,
  supportsTools: true,
  ...overrides,
})

describe('calculateProviderHealth', () => {
  it('returns unconfigured when no keys exist and not keyless', () => {
    expect(calculateProviderHealth([])).toBe('unconfigured')
  })

  it('returns healthy when no keys exist but provider is keyless', () => {
    expect(calculateProviderHealth([], true)).toBe('healthy')
  })

  it('returns unknown when all keys are disabled', () => {
    const keys = [mockApiKey({ enabled: false, status: 'healthy' })]
    expect(calculateProviderHealth(keys)).toBe('unknown')
  })

  it('returns healthy when at least one enabled key is healthy', () => {
    const keys = [
      mockApiKey({ id: 1, status: 'invalid' }),
      mockApiKey({ id: 2, status: 'healthy' }),
    ]
    expect(calculateProviderHealth(keys)).toBe('healthy')
  })

  it('returns rate_limited when enabled keys have rate_limited without healthy', () => {
    const keys = [mockApiKey({ status: 'rate_limited' })]
    expect(calculateProviderHealth(keys)).toBe('rate_limited')
  })

  it('returns issues when enabled keys have invalid or error without healthy', () => {
    const keys = [mockApiKey({ status: 'invalid' })]
    expect(calculateProviderHealth(keys)).toBe('issues')
  })
})

describe('groupProviders', () => {
  it('groups keys and models under standard platforms and sorts configured first', () => {
    const keys = [
      mockApiKey({ platform: 'groq', label: 'Groq Key 1' }),
      mockApiKey({ id: 2, platform: 'cerebras', label: 'Cerebras Key 1' }),
    ]
    const models = [
      mockModel({ id: 1, platform: 'groq', modelId: 'llama-3.3-70b' }),
      mockModel({ id: 2, platform: 'groq', modelId: 'mixtral-8x7b', enabled: false }),
      mockModel({ id: 3, platform: 'google', modelId: 'gemini-2.5-flash' }),
    ]

    const grouped = groupProviders(keys, models)

    // Configured providers should come first
    expect(grouped[0].summary.isConfigured).toBe(true)

    const groqGroup = grouped.find(g => g.platform === 'groq')
    expect(groqGroup).toBeDefined()
    expect(groqGroup!.keys).toHaveLength(1)
    expect(groqGroup!.models).toHaveLength(2)
    expect(groqGroup!.summary.totalKeys).toBe(1)
    expect(groqGroup!.summary.totalModels).toBe(2)
    expect(groqGroup!.summary.activeModels).toBe(1)
    expect(groqGroup!.summary.status).toBe('healthy')
    expect(groqGroup!.summary.isConfigured).toBe(true)

    const googleGroup = grouped.find(g => g.platform === 'google')
    expect(googleGroup).toBeDefined()
    expect(googleGroup!.keys).toHaveLength(0)
    expect(googleGroup!.models).toHaveLength(1)
    expect(googleGroup!.summary.status).toBe('unconfigured')
    expect(googleGroup!.summary.isConfigured).toBe(false)
  })

  it('handles custom endpoints grouped by baseUrl', () => {
    const keys = [
      mockApiKey({ id: 10, platform: 'custom', baseUrl: 'http://localhost:11434/v1', label: 'Local Ollama' }),
      mockApiKey({ id: 11, platform: 'custom', baseUrl: 'https://my-vllm.ai/v1', label: 'vLLM Remote' }),
    ]
    const models = [
      mockModel({ id: 201, platform: 'custom', modelId: 'qwen2.5:7b', keyId: 10 }),
      mockModel({ id: 202, platform: 'custom', modelId: 'llama-3-8b', keyId: 11 }),
    ]

    const grouped = groupProviders(keys, models)
    const customOllama = grouped.find(g => g.baseUrl === 'http://localhost:11434/v1')
    expect(customOllama).toBeDefined()
    expect(customOllama!.keys).toHaveLength(1)
    expect(customOllama!.models).toHaveLength(1)
    expect(customOllama!.models[0].modelId).toBe('qwen2.5:7b')
  })
})

describe('filterGroupedProviders', () => {
  const providers = groupProviders(
    [
      mockApiKey({ platform: 'groq', label: 'Groq Key' }),
      mockApiKey({ id: 2, platform: 'mistral', label: 'Mistral Key', status: 'invalid' }),
    ],
    [
      mockModel({ platform: 'groq', modelId: 'llama-3.3-70b', displayName: 'Llama 3.3 70B' }),
      mockModel({ platform: 'mistral', modelId: 'mistral-large', displayName: 'Mistral Large' }),
      mockModel({ platform: 'cerebras', modelId: 'llama3.1-8b', displayName: 'Llama 3.1 8B' }),
    ],
  )

  it('filters by status: configured vs unconfigured vs issues', () => {
    const configured = filterGroupedProviders(providers, { statusFilter: 'configured' })
    expect(configured.every(p => p.summary.isConfigured)).toBe(true)

    const unconfigured = filterGroupedProviders(providers, { statusFilter: 'unconfigured' })
    expect(unconfigured.every(p => !p.summary.isConfigured)).toBe(true)

    const issues = filterGroupedProviders(providers, { statusFilter: 'issues' })
    expect(issues.some(p => p.platform === 'mistral')).toBe(true)
  })

  it('filters by search matching provider name, key label, or model ID', () => {
    const searchGroq = filterGroupedProviders(providers, { search: 'Groq' })
    expect(searchGroq).toHaveLength(1)
    expect(searchGroq[0].platform).toBe('groq')

    const searchModel = filterGroupedProviders(providers, { search: 'mistral-large' })
    expect(searchModel).toHaveLength(1)
    expect(searchModel[0].platform).toBe('mistral')
  })

  it('hides providers and models according to hidden sets', () => {
    const hiddenProviders = new Set(['groq'])
    const filtered = filterGroupedProviders(providers, {
      showHiddenProviders: false,
      hiddenProviderIds: hiddenProviders,
    })
    expect(filtered.find(p => p.platform === 'groq')).toBeUndefined()

    const hiddenModels = new Set(['groq:llama-3.3-70b'])
    const modelsFiltered = filterGroupedProviders(providers, {
      showHiddenModels: false,
      hiddenModelIds: hiddenModels,
    })
    const groq = modelsFiltered.find(p => p.platform === 'groq')
    expect(groq?.models).toHaveLength(0)
  })
})

describe('localStorage UI state helpers', () => {
  function makeStorage(): Storage {
    const store = new Map<string, string>()
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => { store.clear() },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size },
    }
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', makeStorage())
  })

  it('persists and retrieves hidden providers', () => {
    expect(getHiddenProviders().size).toBe(0)
    setHiddenProviders(new Set(['groq', 'google']))
    const retrieved = getHiddenProviders()
    expect(retrieved.has('groq')).toBe(true)
    expect(retrieved.has('google')).toBe(true)
  })

  it('persists and retrieves hidden models', () => {
    expect(getHiddenModels().size).toBe(0)
    setHiddenModels(new Set(['groq:llama-3.3-70b']))
    const retrieved = getHiddenModels()
    expect(retrieved.has('groq:llama-3.3-70b')).toBe(true)
  })

  it('persists and retrieves collapsed providers', () => {
    expect(getCollapsedProviders().size).toBe(0)
    setCollapsedProviders(new Set(['cerebras']))
    const retrieved = getCollapsedProviders()
    expect(retrieved.has('cerebras')).toBe(true)
  })
})

