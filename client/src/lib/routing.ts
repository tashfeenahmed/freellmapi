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
  tpmLimit?: number | null
  tpdLimit?: number | null
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
  // Which custom endpoint this row belongs to (its base URL), and the model id
  // that names this endpoint's copy on its own. Null for catalog models only:
  // EVERY custom row bound to an endpoint carries both, including the single
  // relay of a one-endpoint install. Neither may be rendered directly —
  // go through memberProviderLabel / providerPinId / memberEndpointTitle, which
  // reveal them only once two endpoints actually collide (#651).
  endpointScope?: string | null
  qualifiedModelId?: string | null
  hasOverrides?: boolean
  // Which fields a local override replaces, so the model page can mark the
  // individual inputs that no longer show the catalog default (#551).
  overrideFields?: string[]
  // The provider reported this model as permanently gone (410 / end of life),
  // so the gateway disabled it by itself — distinct from a switch the user
  // flipped off. `retiredReason` is the upstream wording. See #634.
  retiredUpstream?: boolean
  retiredReason?: string | null
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
  /** Exploration toggle: when on, unmeasured models get a guaranteed chance to
   *  be tried so they build reliability/speed data (#685 follow-up). Required:
   *  the server always sends it, and the checkbox renders straight from it. */
  exploreEnabled: boolean
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

// Two custom endpoints can now each serve the same model id (#651). Short
// host-ish form of an endpoint URL, used only to tell those two apart.
export function endpointShortLabel(scope: string): string {
  return scope.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '')
}

/**
 * The provider label for one row of a group, disambiguated ONLY when it has to
 * be: another row in the same group serves the same model id from a DIFFERENT
 * endpoint. Then the endpoint's URL is appended, because that — not the key
 * label, which defaults to a generic "Custom" and is not required to be unique
 * — is what actually tells the two relays apart. Every catalog model, and every
 * install with a single custom endpoint, gets exactly the label it got before,
 * so there is nothing new to notice until a real collision exists.
 */
export function memberProviderLabel<T extends {
  platform: string; modelId: string; source?: 'catalog' | 'custom'
  keyLabel?: string | null; endpointScope?: string | null
}>(row: T, siblings: readonly T[]): string {
  const base = providerLabel(row)
  if (row.source !== 'custom' || !row.endpointScope) return base
  if (!hasEndpointCollision(row, siblings)) return base
  return `${base} · ${endpointShortLabel(row.endpointScope)}`
}

/**
 * Whether another row shares this row's (platform, model_id) from a DIFFERENT
 * endpoint. Deliberately keyed on that pair alone: display name is presentation
 * (renaming one relay's copy moves it to another group but changes nothing about
 * identity), and a same-id row on another platform is already told apart by its
 * platform. Callers must pass EVERY configured row, not one display group's
 * members, or a renamed sibling goes unseen and the endpoint is hidden exactly
 * when it is needed (#651).
 */
function hasEndpointCollision<T extends {
  platform: string; modelId: string; source?: 'catalog' | 'custom'; endpointScope?: string | null
}>(row: T, siblings: readonly T[]): boolean {
  if (row.source !== 'custom' || !row.endpointScope) return false
  const endpoints = new Set(siblings
    .filter(s => s.platform === row.platform && s.modelId === row.modelId
      && s.source === 'custom' && !!s.endpointScope)
    .map(s => s.endpointScope))
  return endpoints.size > 1
}

/**
 * The full endpoint URL to reveal on hover, or undefined when there is nothing
 * to disambiguate. Gated on the SAME collision test as the visible label rather
 * than on `endpointScope` alone — every custom row carries a scope, so gating on
 * the field itself would pop a tooltip with the user's own base URL on a
 * single-endpoint install, which is exactly what #651 must not do.
 */
export function memberEndpointTitle<T extends {
  platform: string; modelId: string; source?: 'catalog' | 'custom'
  keyLabel?: string | null; endpointScope?: string | null
}>(row: T, siblings: readonly T[]): string | undefined {
  if (memberProviderLabel(row, siblings) === providerLabel(row)) return undefined
  return row.endpointScope ?? undefined
}

/**
 * The id to send when you want THIS provider's copy. The bare model id, as
 * always — except when two custom endpoints in the group serve it, where only
 * the endpoint-qualified id the server computed names one of them.
 */
export function providerPinId<T extends {
  platform: string; modelId: string; source?: 'catalog' | 'custom'
  endpointScope?: string | null; qualifiedModelId?: string | null
}>(row: T, siblings: readonly T[]): string {
  if (!row.qualifiedModelId) return row.modelId
  return hasEndpointCollision(row, siblings) ? row.qualifiedModelId : row.modelId
}

/**
 * The member id a unify split/merge override should be written against. Unlike
 * the ids shown to users, this is ALWAYS the qualified form for a row that has
 * an endpoint: an override is persisted state, so it has to keep naming the same
 * row even after the sibling that caused the collision is removed. The server
 * matches the plain member id too, so overrides written before #651 still apply.
 */
export function memberOverrideKey(row: {
  platform: string; modelId: string; qualifiedModelId?: string | null
}): string {
  return row.qualifiedModelId ?? `${row.platform}:${row.modelId}`
}

type OverrideRow = { platform: string; modelId: string; qualifiedModelId?: string | null }
type SplitEntry = { member: string; groupKey?: string }

/**
 * Every persisted form that names this row: the qualified id written since #651,
 * and the plain "platform:modelId" that overrides saved before it use. Matching
 * both is what keeps an existing split undoable — the alternative, rewriting
 * stored keys on read, is a silent data migration for a cosmetic gain.
 */
function overrideKeyAliases(row: OverrideRow): string[] {
  const plain = `${row.platform}:${row.modelId}`
  return row.qualifiedModelId && row.qualifiedModelId !== plain
    ? [row.qualifiedModelId, plain]
    : [plain]
}

/** Whether a persisted split names this row, in either form. */
export function isMemberSplit(splits: readonly SplitEntry[], row: OverrideRow): boolean {
  const aliases = overrideKeyAliases(row)
  return splits.some(s => aliases.includes(s.member))
}

/** The splits list with this row's entry dropped, whichever form it was saved in. */
export function splitsWithoutMember(splits: readonly SplitEntry[], row: OverrideRow): SplitEntry[] {
  const aliases = overrideKeyAliases(row)
  return splits.filter(s => !aliases.includes(s.member))
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
  aion:         '#6366f1',
  requesty:    '#10b981',
  navy:         '#1d4ed8',
  nara:         '#2563eb',
  sealion:     '#0ea5e9',
  anyapi:      '#0891b2',
  modelscope:  '#624aff',
  aihorde:     '#dc2626',
  agentrouter: '#7c3aed',
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
