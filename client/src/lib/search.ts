// Web search (#1174): the dashboard side of POST /v1/search and the catalog's
// `searchEngines` section. Search providers hold keys like any other platform,
// but they never serve chat, so the Keys page, the add-key picker and the
// Models tabs all treat them as their own group.

import type { SearchPlatform as SharedSearchPlatform } from '@freellmapi/shared/types'

// Mirrors SEARCH_PLATFORMS in shared/types.ts. The client only imports types
// from shared, so the list is repeated here; the two assertions below fail the
// typecheck if either side gains a platform the other lacks.
export const SEARCH_PLATFORMS = ['tavily', 'exa', 'firecrawl', 'linkup', 'parallel', 'serpsearch', 'keenable', 'brave'] as const
export type SearchPlatform = (typeof SEARCH_PLATFORMS)[number]
const sharedCoversClient: SharedSearchPlatform = '' as SearchPlatform
const clientCoversShared: SearchPlatform = '' as SharedSearchPlatform
void sharedCoversClient
void clientCoversShared

export function isSearchPlatform(platform: string): platform is SearchPlatform {
  return (SEARCH_PLATFORMS as readonly string[]).includes(platform)
}

// Same shape and job as PLATFORMS in components/keys/shared.tsx: the label
// names the free allowance, `url` is where the key is created, and `keyless`
// providers work with no key (a blank submit enables the anonymous tier).
export const SEARCH_PROVIDERS: { value: SearchPlatform; label: string; url: string; keyless?: boolean }[] = [
  { value: 'tavily', label: 'Tavily (1,000 searches/month)', url: 'https://app.tavily.com/home' },
  { value: 'exa', label: 'Exa ($10 search credits/month)', url: 'https://dashboard.exa.ai/api-keys' },
  { value: 'firecrawl', label: 'Firecrawl (1,000 credits/month)', url: 'https://www.firecrawl.dev/app/api-keys' },
  { value: 'linkup', label: 'Linkup (€5 credits/month)', url: 'https://app.linkup.so/api-keys' },
  { value: 'parallel', label: 'Parallel (no key needed)', url: 'https://platform.parallel.ai', keyless: true },
  { value: 'serpsearch', label: 'SerpSearch (1,000 searches/month)', url: 'https://serpsearch.com/dashboard/api-keys' },
  { value: 'keenable', label: 'Keenable (no key needed)', url: 'https://keenable.ai', keyless: true },
  { value: 'brave', label: 'Brave Search (free monthly credits)', url: 'https://api-dashboard.search.brave.com/app/keys' },
]

/** Short provider name for chips and badges ("Tavily", not the full label). */
export function searchProviderName(platform: string): string {
  const label = SEARCH_PROVIDERS.find(p => p.value === platform)?.label
  return label ? label.replace(/\s*\(.*\)$/, '') : platform
}

/** GET /api/search/engines row. */
export interface SearchEngine {
  id: number
  platform: string
  engineId: string
  displayName: string
  priority: number
  enabled: boolean
  quotaLabel: string
  creditsPerQuery: number | null
  features: { news?: boolean; answer?: boolean; fullContent?: boolean } | null
  premiumSince: string | null
  keyCount: number
  healthyKeyCount: number
  searchesThisMonth: number
}

/** GET /api/analytics/search response. */
export interface SearchAnalytics {
  total: number
  today: number
  successRate: number
  avgLatencyMs: number
  byEngine: { engineId: string; displayName: string; count: number }[]
  series: { date: string; engineId: string; count: number }[]
}

export interface SearchHit {
  title: string
  url: string
  content: string
  score: number
}

/** POST /v1/search response. */
export interface SearchResult {
  query: string
  answer?: string
  results: SearchHit[]
  provider: string
  engine: string
}

// New catalog rows reach Free installs this long after they reach Premium.
const FREE_TIER_LAG_MS = 30 * 24 * 60 * 60 * 1000

/**
 * When a Premium-first engine reaches the free catalog, or null when it is
 * already free (no stamp, an unreadable stamp, or the lag has passed).
 */
export function freeFromDate(premiumSince: string | null, now: number = Date.now()): Date | null {
  if (!premiumSince) return null
  const since = Date.parse(premiumSince)
  if (Number.isNaN(since)) return null
  const freeAt = since + FREE_TIER_LAG_MS
  return freeAt > now ? new Date(freeAt) : null
}

/** Enabled engines in failover order, for the "Auto (Tavily → Exa)" line. */
export function engineChain(engines: SearchEngine[]): SearchEngine[] {
  return engines
    .filter(e => e.enabled)
    .slice()
    .sort((a, b) => a.priority - b.priority || a.displayName.localeCompare(b.displayName))
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * The system message the Playground sends ahead of a web-searched question:
 * numbered sources the model is told to cite as [n]. Snippets are capped so a
 * long page cannot crowd the question out of a small context window.
 */
export function searchContextMessage(result: SearchResult, maxSnippet = 600): string {
  const lines = result.results.map((hit, i) => {
    const snippet = hit.content.length > maxSnippet ? `${hit.content.slice(0, maxSnippet)}…` : hit.content
    return `[${i + 1}] ${hit.title || hostOf(hit.url)} (${hit.url})\n${snippet}`
  })
  return [
    `Web search results for "${result.query}":`,
    ...(result.answer ? [`Summary: ${result.answer}`] : []),
    ...lines,
    'Use these results to answer, and cite them inline as [1], [2] where they support a claim. If they do not answer the question, say so.',
  ].join('\n\n')
}
