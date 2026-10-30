// Shapes GLIXEL reads from existing endpoints, and the pure logic that turns
// them into what the command center shows. Nothing here invents a value: a
// figure the server did not report stays null and renders as "no data".

/** Subset of GET /api/providers this increment uses. */
export interface ProviderTelemetry {
  platform: string
  name: string
  kind: 'chat' | 'search'
  state: 'connected' | 'unhealthy' | 'disabled' | 'unconfigured'
  automaticRouting: { eligible: boolean; reason?: string }
  lastCheckedAt: string | null
  models: { enabled: number; automaticallyRoutable: number }
  traffic24h: { requests: number; successRate: number | null; avgLatencyMs: number | null }
  cooldowns: { active: number; soonestExpiresAt: string | null }
}

export interface ProvidersTelemetry {
  generatedAt: string
  freeOnly: { enabled: boolean; optedIn: Array<{ platform: string; warning: string | null }> }
  providers: ProviderTelemetry[]
}

/** The `degradation` field of GET /api/health. */
export interface DegradationTelemetry {
  state: string
  healthyProviders: number
  totalProviders: number
  ratio: number
  degradedAt: number | null
}

export interface HealthTelemetry {
  degradation: DegradationTelemetry
}

export type Freshness = 'loading' | 'live' | 'stale' | 'unavailable'

/** Data older than this (or a failed refresh) is shown as stale. */
export const STALE_AFTER_MS = 150_000

export function freshness(opts: { hasData: boolean; fetchedAt: number | undefined; failed: boolean; loading: boolean; now: number }): Freshness {
  if (!opts.hasData) return opts.loading ? 'loading' : 'unavailable'
  if (opts.failed) return 'stale'
  if (opts.fetchedAt === undefined || opts.now - opts.fetchedAt > STALE_AFTER_MS) return 'stale'
  return 'live'
}

export interface FleetSummary {
  connected: number
  unhealthy: number
  disabled: number
  unconfigured: number
  automaticallyRoutableModels: number
  activeCooldowns: number
  requests24h: number
  /** null when no provider reported a success rate. */
  successRate24h: number | null
  /** Request-weighted mean of provider averages; null without data. */
  avgLatencyMs24h: number | null
}

export function summarizeFleet(providers: ProviderTelemetry[]): FleetSummary {
  const chat = providers.filter(p => p.kind === 'chat')
  const count = (s: ProviderTelemetry['state']) => chat.filter(p => p.state === s).length
  let okWeighted = 0
  let rateRequests = 0
  let latencyWeighted = 0
  let latencyRequests = 0
  for (const p of chat) {
    const { requests, successRate, avgLatencyMs } = p.traffic24h
    if (requests > 0 && successRate !== null) { okWeighted += successRate * requests; rateRequests += requests }
    if (requests > 0 && avgLatencyMs !== null) { latencyWeighted += avgLatencyMs * requests; latencyRequests += requests }
  }
  return {
    connected: count('connected'),
    unhealthy: count('unhealthy'),
    disabled: count('disabled'),
    unconfigured: count('unconfigured'),
    // Only connected providers: a model the policy allows on a provider with no
    // usable key cannot actually be routed to.
    automaticallyRoutableModels: chat.filter(p => p.state === 'connected').reduce((n, p) => n + p.models.automaticallyRoutable, 0),
    activeCooldowns: chat.reduce((n, p) => n + p.cooldowns.active, 0),
    requests24h: chat.reduce((n, p) => n + p.traffic24h.requests, 0),
    successRate24h: rateRequests > 0 ? okWeighted / rateRequests : null,
    avgLatencyMs24h: latencyRequests > 0 ? Math.round(latencyWeighted / latencyRequests) : null,
  }
}

const STATE_RANK: Record<ProviderTelemetry['state'], number> = { unhealthy: 0, connected: 1, disabled: 2, unconfigured: 3 }

/** Providers worth a row: configured chat providers, problems first. */
export function configuredProviders(providers: ProviderTelemetry[]): ProviderTelemetry[] {
  return providers
    .filter(p => p.kind === 'chat' && p.state !== 'unconfigured')
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name))
}

/** Server timestamps arrive as ISO or SQLite "YYYY-MM-DD HH:MM:SS" (UTC). */
export function parseServerTime(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatClock(date: Date | null): string {
  return date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'
}

export function formatPercent(value: number | null): string {
  return value === null ? 'no data' : `${Math.round(value * 100)}%`
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return 'no data'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}
