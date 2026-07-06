// Routing/model-table domain types and pure helpers, extracted from
// FallbackPage so the Models page, the per-model detail page, and the command
// palette share one module instead of importing from a page component.

export interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
  // Parsed token count from the server (single source of truth — see
  // server/src/lib/budget.ts). Optional only because the dev mock omits it.
  monthlyTokenBudgetTokens?: number
  // Max context length in tokens (catalog value), or null when unrecorded.
  // Drives the catalog context-window filter on the Models page.
  contextWindow?: number | null
  supportsVision: boolean
  supportsTools: boolean
  source?: 'catalog' | 'custom'
  keyId?: number | null
  keyLabel?: string | null
  hasOverrides?: boolean
  keyCount: number
  // Logical-model grouping (sent by the server when unify is relevant). Absent
  // for ungrouped rows; the UI falls back to a per-row "solo" group then.
  groupKey?: string
  canonicalId?: string
  groupLabel?: string
}

export type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom'

export type RoutingWeights = { reliability: number; speed: number; intelligence: number }

export interface RoutingScore {
  modelDbId: number
  reliability: number
  speed: number
  intelligence: number
  headroom: number
  rateLimit: number
  score: number
  totalRequests: number
}

export interface RoutingData {
  strategy: RoutingStrategy
  weights: RoutingWeights | null
  customWeights: RoutingWeights
  scores: (RoutingScore & { platform: string; modelId: string; displayName: string; enabled: boolean })[]
}

// A merged row: fallback-chain metadata + live bandit scores.
export type Row = FallbackEntry & Partial<RoutingScore>

export interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: { displayName: string; platform: string; modelId?: string; budget: number; used?: number }[]
}

// Custom endpoints all share the generic 'custom' platform id, so show the
// user's key label ("Ollama box") instead so the models list names the actual
// provider. Falls back to the platform for catalog models (and unlabeled custom
// keys, whose label defaults to "Custom"). (#469)
export function providerLabel(row: { platform: string; source?: 'catalog' | 'custom'; keyLabel?: string | null }): string {
  if (row.source === 'custom' && row.keyLabel && row.keyLabel.trim()) return row.keyLabel
  return row.platform
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatPercent(value: number): string {
  const pct = Math.max(0, Math.min(100, value * 100))
  if (pct > 0 && pct < 0.1) return '<0.1%'
  if (pct > 99.9 && pct < 100) {
    const floored = Math.floor(pct * 100) / 100
    return `${floored.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`
  }
  const digits = pct < 10 ? 1 : 0
  return `${pct.toFixed(digits).replace(/\.0$/, '')}%`
}

// Compact context-window label (whole-number K/M, base 1000): 8000 → "8K",
// 128000 → "128K", 1_000_000 → "1M". Used by the catalog context badge/filter.
export function formatContext(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

// The largest context window across a logical model's providers.
export function groupMaxContext(members: Row[]): number {
  return Math.max(0, ...members.map(m => m.contextWindow ?? 0))
}

// For models with no monthly token budget, surface their rate quota instead.
// Strips the catalog's decorative bits ("free · ", " per IP", "~", "?") so e.g.
// "free · 40 RPM" → "40 RPM", "free · 200/hr per IP" → "200/hr", "~? (anon)" →
// "anon". Returns null when nothing meaningful remains.
export function cleanQuotaLabel(s: string | undefined): string | null {
  if (!s) return null
  let c = s
    .replace(/free\s*·\s*/ig, '')
    .replace(/\s*per ip\s*/ig, '')
    .replace(/[~?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  c = c.replace(/^\(([^()]*)\)$/, '$1').trim()
  return c || null
}

// The quota badge for a logical model: its summed monthly token budget when it
// has one (you can spend all providers' budgets via failover), else the best
// rate cap (RPM/RPD, or the catalog's rate label) for rate-limited providers.
// Shared by the Models-page group header and the per-model detail page.
export function groupQuotaBadge(
  members: Row[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): { text: string; title: string } | null {
  const totalBudget = members.reduce((sum, m) => sum + (m.monthlyTokenBudgetTokens ?? 0), 0)
  const maxRpm = Math.max(0, ...members.map(m => m.rpmLimit ?? 0))
  const maxRpd = Math.max(0, ...members.map(m => m.rpdLimit ?? 0))
  const rateLabelText = members.map(m => cleanQuotaLabel(m.monthlyTokenBudget)).find(Boolean) ?? null
  if (totalBudget > 0) return { text: t('models.aggregateBudget', { count: formatTokens(totalBudget) }), title: t('models.aggregateBudgetTitle') }
  if (maxRpm > 0) return { text: t('models.rateRpm', { count: maxRpm }), title: t('models.rateTitle') }
  if (maxRpd > 0) return { text: t('models.rateRpd', { count: maxRpd }), title: t('models.rateTitle') }
  if (rateLabelText) return { text: rateLabelText, title: t('models.rateTitle') }
  return null
}

export const platformColors: Record<string, string> = {
  google:      '#4285f4',
  groq:        '#f55036',
  cerebras:    '#8b5cf6',
  nvidia:      '#76b900',
  mistral:     '#f59e0b',
  openrouter:  '#ec4899',
  github:      '#6e7b8b',
  cohere:      '#d946ef',
  cloudflare:  '#f38020',
  zhipu:       '#06b6d4',
  ollama:      '#000000',
  kilo:        '#7c3aed',
  pollinations: '#a855f7',
  llm7:        '#0ea5e9',
  huggingface: '#ff9d00',
  routeway:    '#14b8a6',
  bazaarlink:  '#e11d48',
  ainative:    '#22c55e',
  aihorde:     '#dc2626',
}

// ── Grouped (unified) rendering ──────────────────────────────────────────────
// One logical model and the provider rows that serve it.
export interface ModelGroupRow {
  key: string
  label: string
  members: Row[]
}

// Group merged rows by their server-assigned groupKey (or a per-row "solo" key
// when ungrouped). Members are ordered like the flat chain — by manual priority
// under the priority strategy, by live score otherwise — and groups inherit the
// best member's position so the unified order matches the flat order.
export function buildGroups(rows: Row[], isManual: boolean): ModelGroupRow[] {
  const map = new Map<string, Row[]>()
  for (const r of rows) {
    const key = r.groupKey ?? `solo:${r.modelDbId}`
    const arr = map.get(key)
    if (arr) arr.push(r)
    else map.set(key, [r])
  }
  const groups = [...map.entries()].map(([key, members]) => ({
    key,
    label: members[0].groupLabel ?? members[0].displayName,
    members: [...members].sort((a, b) => (isManual ? a.priority - b.priority : (b.score ?? 0) - (a.score ?? 0))),
  }))
  groups.sort((a, b) =>
    isManual
      ? Math.min(...a.members.map(m => m.priority)) - Math.min(...b.members.map(m => m.priority))
      : Math.max(...b.members.map(m => m.score ?? 0)) - Math.max(...a.members.map(m => m.score ?? 0)),
  )
  return groups
}
