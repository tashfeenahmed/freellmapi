import { describe, expect, it } from 'vitest'
import {
  engineChain,
  freeFromDate,
  hostOf,
  isSearchPlatform,
  searchContextMessage,
  searchProviderName,
  searchReadinessHint,
  type SearchEngine,
  type SearchReadiness,
} from './search'

const engine = (over: Partial<SearchEngine>): SearchEngine => ({
  id: 1,
  platform: 'tavily',
  engineId: 'tavily-search',
  displayName: 'Tavily',
  priority: 0,
  enabled: true,
  quotaLabel: '',
  creditsPerQuery: 1,
  features: null,
  premiumSince: null,
  keyCount: 1,
  healthyKeyCount: 1,
  searchesThisMonth: 0,
  ...over,
})

describe('search readiness diagnostics', () => {
  const base: SearchReadiness = { status: 'needs_configuration', engines: [], missing_from_catalog: [],
    catalog: { appliedVersion: null, appliedTier: null, lastSyncMs: null, lastError: null } }
  const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? `:${JSON.stringify(vars)}` : ''}`
  it('distinguishes API failures and loading from missing keys', () => {
    expect(searchReadinessHint(undefined, true, false, t)).toBe('search.readinessError')
    expect(searchReadinessHint(undefined, false, true, t)).toBe('common.loading')
  })
  it('names configured providers missing from the catalog instead of asking for more keys', () => {
    expect(searchReadinessHint({ ...base, missing_from_catalog: ['parallel', 'keenable'] }, false, false, t))
      .toBe('search.catalogMissing:{"providers":"Parallel, Keenable"}')
  })
  it('surfaces the catalog sync error and a genuinely empty catalog separately', () => {
    expect(searchReadinessHint({ ...base, catalog: { ...base.catalog, lastError: 'bad signature' } }, false, false, t))
      .toBe('premium.lastSyncProblem:{"error":"bad signature"}')
    expect(searchReadinessHint(base, false, false, t)).toBe('search.empty')
  })
  it.each(['disabled', 'cooling_down', 'needs_key', 'key_error'] as const)('explains engine state %s', state => {
    const s = { ...base, status: state === 'cooling_down' ? 'cooling_down' as const : 'needs_configuration' as const,
      engines: [{ engine: 'exa-search', platform: 'exa', state }] }
    const key = state === 'disabled' ? 'search.enginesDisabled' : state === 'cooling_down' ? 'search.keysCoolingDown' : 'search.keysNotReady'
    expect(searchReadinessHint(s, false, false, t)).toBe(key)
  })
})

describe('search platforms', () => {
  it('recognises the search providers and nothing else', () => {
    expect(isSearchPlatform('tavily')).toBe(true)
    expect(isSearchPlatform('linkup')).toBe(true)
    expect(isSearchPlatform('groq')).toBe(false)
    expect(isSearchPlatform('custom')).toBe(false)
  })

  it('shortens the provider label to its name', () => {
    expect(searchProviderName('exa')).toBe('Exa')
    expect(searchProviderName('unknown')).toBe('unknown')
  })
})

describe('freeFromDate', () => {
  const now = Date.parse('2026-10-13T00:00:00Z')

  it('is null for rows without a premium stamp', () => {
    expect(freeFromDate(null, now)).toBeNull()
    expect(freeFromDate('not a date', now)).toBeNull()
  })

  it('returns the day the row reaches the free catalog', () => {
    expect(freeFromDate('2026-10-13T00:00:00Z', now)?.toISOString()).toBe('2026-11-12T00:00:00.000Z')
  })

  it('is null once the 30-day lag has passed', () => {
    expect(freeFromDate('2026-09-01T00:00:00Z', now)).toBeNull()
  })
})

describe('engineChain', () => {
  it('keeps enabled engines in priority order', () => {
    const chain = engineChain([
      engine({ id: 2, displayName: 'Exa', priority: 1 }),
      engine({ id: 3, displayName: 'Linkup', priority: 3, enabled: false }),
      engine({ id: 1, displayName: 'Tavily', priority: 0 }),
    ])
    expect(chain.map(e => e.displayName)).toEqual(['Tavily', 'Exa'])
  })
})

describe('searchContextMessage', () => {
  it('numbers the sources and caps long snippets', () => {
    const text = searchContextMessage({
      query: 'what is freellmapi',
      provider: 'tavily',
      engine: 'tavily-search',
      results: [
        { title: 'README', url: 'https://github.com/x/y', content: 'a'.repeat(700), score: 0.9 },
        { title: '', url: 'https://www.freellmapi.co/docs', content: 'docs', score: 0.5 },
      ],
    })
    expect(text).toContain('[1] README (https://github.com/x/y)')
    expect(text).toContain('[2] freellmapi.co (https://www.freellmapi.co/docs)')
    expect(text).toContain(`${'a'.repeat(600)}…`)
    expect(text).not.toContain('a'.repeat(601))
  })

  it('falls back to the raw string for an unparseable url', () => {
    expect(hostOf('not a url')).toBe('not a url')
  })
})
