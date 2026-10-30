// Types and pure helpers for the Providers page (GET /api/providers), kept
// apart from the component so fast refresh works and tests can import them.

export type ProviderState = 'connected' | 'unhealthy' | 'disabled' | 'unconfigured'

export interface ProviderOverview {
  platform: string
  name: string
  kind: 'chat' | 'search'
  keyless: boolean
  credentialsRequired: boolean
  state: ProviderState
  metadata: {
    freeTier: string
    confidence: 'low' | 'medium' | 'high'
    summary: string
    restrictions: string[]
    trainsOnPrompts?: boolean
    docsUrl: string | null
    docsUrlSource: 'repo' | 'unchecked' | null
    quotasPublished: string
  }
  verification: { status: 'officially-verified' | 'repo-documented' | 'none'; verifiedOn: string | null }
  automaticRouting: { eligible: boolean; reason?: string }
  keys: {
    total: number
    items: Array<{ id: number; label: string | null; status: string; enabled: boolean; lastCheckedAt: string | null; lastHealthError: string | null }>
  }
  lastCheckedAt: string | null
  models: { enabled: number; automaticallyRoutable: number }
  traffic24h: { requests: number; successRate: number | null; avgLatencyMs: number | null }
  cooldowns: { active: number; soonestExpiresAt: string | null }
  providerReportedQuota: Array<{ metric: string; limit: number | null; remaining: number | null }>
}

export interface ProvidersResponse {
  freeOnly: { enabled: boolean; optedIn: Array<{ platform: string; warning: string | null }> }
  providers: ProviderOverview[]
}

export type Filter = 'all' | ProviderState
export const FILTERS: Filter[] = ['all', 'connected', 'unhealthy', 'unconfigured', 'disabled']
const STATE_ORDER: Record<ProviderState, number> = { connected: 0, unhealthy: 1, disabled: 2, unconfigured: 3 }

/** Filter + sort used by the page; exported for tests. */
export function visibleProviders(providers: ProviderOverview[], filter: Filter, query: string): ProviderOverview[] {
  const q = query.trim().toLowerCase()
  return providers
    .filter(p => p.kind === 'chat')
    .filter(p => filter === 'all' || p.state === filter)
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.platform.includes(q))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name))
}
