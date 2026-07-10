import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { Search, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip as HoverTooltip } from '@/components/tooltip'
import { cn, formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useI18n } from '@/i18n'

type TimeRange = '24h' | '7d' | '30d' | '90d'

// Response shapes mirror the JSON emitted by server/src/routes/analytics.ts.
// Latency percentiles and TTFT are null when the raw window is empty (pruned).
interface SummaryResponse {
  totalRequests: number
  successRate: number
  totalInputTokens: number
  totalOutputTokens: number
  avgLatencyMs: number
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  avgTtfbMs: number | null
  requestTypeCounts: { chat: number; embedding: number }
  estimatedCostSavings: number
  pinnedRequests: number
  pinHonoredRequests: number
  firstRequestAt: string | null
  lifetimeTotalRequests: number
}

interface ByPlatformRow {
  platform: string
  requests: number
  successRate: number
  avgLatencyMs: number
  p95LatencyMs: number | null
  avgTtfbMs: number | null
  errorCount: number
  avgTokensPerSecond: number | null
  totalInputTokens: number
  totalOutputTokens: number
}

interface TimelineBucket {
  timestamp: string
  requests: number
  successCount: number
  failureCount: number
  inputTokens: number
  outputTokens: number
}

interface ByModelRow {
  platform: string
  modelId: string
  displayName: string
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
  pinnedRequests: number
  estimatedCost: number
}

interface ByKeyRow {
  keyId: number
  label: string | null
  platform: string | null
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
}

interface ErrorDistribution {
  byCategory: Array<{ category: string; count: number }>
  byPlatform: Array<{ platform: string; count: number }>
  detailed: Array<{ platform: string; model_id: string; error_category: string; count: number }>
}

interface RecentErrorRow {
  id: number
  platform: string
  modelId: string
  error: string
  latencyMs: number
  createdAt: string
}

interface RecentCallRow {
  id: number
  platform: string
  modelId: string
  requestedModel: string | null
  requestType: string
  status: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  error: string | null
  clientIp: string | null
  clientUserAgent: string | null
  createdAt: string
}

interface RecentCallsResponse {
  total: number
  rows: RecentCallRow[]
}

// First product token of the UA ("python-requests/2.32.3", "curl/8.6.0", …)
// is enough to tell callers apart in a narrow cell; full string on hover.
function shortUserAgent(ua: string | null): string {
  if (!ua) return '—'
  const first = ua.split(' ')[0]
  return first.length > 32 ? first.slice(0, 32) + '…' : first
}

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function Stat({ label, value, hint, className }: { label: string; value: string | number; hint?: string; className?: string }) {
  const card = (
    <div className="rounded-3xl border bg-card px-4 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
  // Same portal tooltip as the routing strategy chips. Opens BELOW the card:
  // the stats row sits right under the sticky navbar.
  return hint ? <HoverTooltip text={hint} side="bottom" className="block">{card}</HoverTooltip> : card
}

// Panel card. The same `highlighted` ring used on the toolbar (#fe1) wraps
// the card when its data is being filtered by the search box — same
// primary-tinted ring, same shadow, same transition duration so the input
// row and the table pulse in sync. `countLabel` is the pre-rendered top-right
// text (parent calls `t('analytics.matchedCount', …)` so this component stays
// presentational and doesn't need the i18n hook in scope). Same
// flex/justify-between keeps the title left + count right even when no
// count is rendered, so the title doesn't shift when a filter is applied.
function Panel({
  title,
  children,
  highlighted = false,
  countLabel,
}: {
  title: string
  children: React.ReactNode
  highlighted?: boolean
  countLabel?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "rounded-3xl border bg-card transition-shadow duration-200",
        highlighted && "ring-2 ring-primary/50 shadow-lg shadow-primary/10"
      )}
    >
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {highlighted && countLabel != null && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {countLabel}
          </span>
        )}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'
const tooltipStyle = { backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 } as const

// Two categorical series hues, validated against the app's actual chart
// surfaces (light card #ffffff, dark card #101010) with the dataviz palette
// checker. Slot A (blue) = the "average / input" series; slot B (aqua) = the
// "p95 / output" series. The app's own --chart-* tokens are all grayscale
// (zero chroma), which fails the CVD separation check for a two-series chart,
// so we take the nearest passing categorical hues and theme them here.
const seriesA = 'var(--series-a)'
const seriesB = 'var(--series-b)'
const chartVars = `
.analytics-viz { --series-a: #2a78d6; --series-b: #1baf7a; }
.dark .analytics-viz { --series-a: #3987e5; --series-b: #199e70; }
`

// One filter matches if the query (trimmed, lower-cased) appears anywhere in the
// joined, lower-cased haystack. Empty query short-circuits to "match all" so
// the underlying array stays untouched. Case-insensitive substring (not fuzzy,
// not regex) — same shape FallbackPage uses (#343), so power users get one
// mental model across the dashboard.
type MatchesFn<T> = (row: T, q: string) => boolean
function makeMatches<T>(getHaystack: (row: T) => string): MatchesFn<T> {
  return (row, q) => {
    if (!q) return true
    return getHaystack(row).toLowerCase().includes(q)
  }
}

export default function AnalyticsPage() {
  const { t } = useI18n()
  const [range, setRange] = useState<TimeRange>('7d')
  // Capture "now" once at mount so the savings extrapolation below stays a pure
  // render (calling Date.now() during render is impure and non-deterministic).
  const [now] = useState(() => Date.now())
  // Page-wide filter. Filtered client-side over already-fetched rows so
  // keystrokes don't re-hit the API (the useQuery keys stay range-only).
  // NOT persisted: the search box resets to empty on every page mount, same
  // shape as FallbackPage and ProviderList. The user is more often
  // investigating a one-off pattern than narrowing repeatedly across visits,
  // and persistence makes the page land in a half-filtered state from a
  // deep link with no context.
  //
  // The `scope` chip selects which tables the search applies to. Default
  // 'all' preserves the prior behavior; the other values narrow the
  // filter to a single table so typing in the box doesn't shrink panels
  // the user isn't looking at. Tables outside the active scope render
  // unfiltered.
  //
  // The query is trimmed + lowered once at the top of the filter
  // pipeline — passing it through unchanged means each `matches` impl
  // stays pure, but the trim+lower happens in every render where the
  // user typed. Cheap (4 memoized filters, total dataset < few hundred
  // rows).
  type SearchScope = 'all' | 'models' | 'calls' | 'errors' | 'keys'
  const [search, setSearch] = useState<string>('')
  const [scope, setScope] = useState<SearchScope>('all')
  const trimmedQuery = search.trim().toLowerCase()
  const hasQuery = trimmedQuery.length > 0

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<SummaryResponse>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<ByPlatformRow[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<TimelineBucket[]>(`/api/analytics/timeline?range=${range}`),
  })

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<ByModelRow[]>(`/api/analytics/by-model?range=${range}`),
  })

  const { data: byKey = [] } = useQuery({
    queryKey: ['analytics', 'by-key', range],
    queryFn: () => apiFetch<ByKeyRow[]>(`/api/analytics/by-key?range=${range}`),
  })

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<RecentErrorRow[]>(`/api/analytics/errors?range=${range}`),
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<ErrorDistribution>(`/api/analytics/error-distribution?range=${range}`),
  })

  const { data: recentCalls } = useQuery({
    queryKey: ['analytics', 'requests', range],
    queryFn: () => apiFetch<RecentCallsResponse>(`/api/analytics/requests?range=${range}&limit=100`),
  })

  // Savings card shows ONE stable monthly figure regardless of the selected
  // range: the last-30-days data projected to a full month from its actual
  // span (a young install with 2 days of data shows 15x its 2-day total).
  // Once 30 days of history exist the real total shows as-is. The hover
  // hint carries the selected period's actual amount and the projection
  // basis. Querying 30d separately is free: react-query shares the cache
  // with the 30d tab.
  const { data: summary30 } = useQuery({
    queryKey: ['analytics', 'summary', '30d'],
    queryFn: () => apiFetch<SummaryResponse>(`/api/analytics/summary?range=30d`),
  })
  // ----- Page-wide filter ----------------------------------------------------
  // One matches() builder per table, joined so the haystack is computed once
  // per row in the filter pass (instead of three times via three separate
  // predicates). For rows whose every field is a string primitive this is just
  // template-literal concatenation. The four tables each carry slightly
  // different searchable fields, so the haystack text is bespoke per row
  // type. Charts are deliberately NOT filtered — they aggregate over the
  // selected window and filtering them would misrepresent totals; the
  // summary stat cards and time-series charts already stay unfiltered.
  const matchesByModel = useMemo(
    () => makeMatches<ByModelRow>((r) => `${r.displayName} ${r.platform} ${r.modelId}`),
    []
  )
  const matchesByKey = useMemo(
    () => makeMatches<ByKeyRow>((r) => `${r.label ?? ''} ${r.platform ?? ''} #${r.keyId}`),
    []
  )
  const matchesRecentCall = useMemo(
    () => makeMatches<RecentCallRow>((r) =>
      `${r.clientIp ?? ''} ${r.clientUserAgent ?? ''} ${r.modelId} ${r.platform} ` +
      `${r.requestedModel ?? ''} ${r.status} ${r.error ?? ''} ${r.requestType}`
    ),
    []
  )
  const matchesRecentError = useMemo(
    () => makeMatches<RecentErrorRow>((r) => `${r.platform} ${r.modelId} ${r.error}`),
    []
  )
  // Filtered versions of every list-driven surface. Each uses .filter + the
  // `matches` helper so an empty query returns the array unmodified (no copy
  // when there is no filter — saves an allocation per render in the common
  // case). useMemo deps include trimmedQuery so a keystroke recomputes only
  // what's affected; the dependencies on the source arrays keep the filter
  // in sync with re-fetches when range changes.
  // Per-table filtered arrays. The filter only applies when:
  //   1. there's a non-empty query, AND
  //   2. the active scope includes the table.
  // A table outside the active scope renders unfiltered even with text in the
  // box — that's the whole point of the scope chip. Empty query short-circuits
  // to the source array (no allocation in the common no-filter case). The
  // `highlight*` flags drive the panel ring + match-count display: a panel
  // highlights only when it's in scope AND the filter produced ≥1 match.
  // Zero matches in a panel = no highlight, no count, full table (the panel
  // is a no-op for this query and renders as if there were no filter).
  const inScope = (kind: 'models' | 'calls' | 'errors' | 'keys') =>
    scope === 'all' || scope === kind
  const visibleByModel = useMemo(
    () => hasQuery && inScope('models')
      ? byModel.filter((r) => matchesByModel(r, trimmedQuery))
      : byModel,
    [byModel, matchesByModel, trimmedQuery, hasQuery, scope]
  )
  const visibleErrors = useMemo(
    () => hasQuery && inScope('errors')
      ? errors.filter((r) => matchesRecentError(r, trimmedQuery))
      : errors,
    [errors, matchesRecentError, trimmedQuery, hasQuery, scope]
  )
  const visibleByKey = useMemo(
    () => hasQuery && inScope('keys')
      ? byKey.filter((r) => matchesByKey(r, trimmedQuery))
      : byKey,
    [byKey, matchesByKey, trimmedQuery, hasQuery, scope]
  )
  const visibleRecentCalls = useMemo(() => {
    const rows = recentCalls?.rows
    if (!rows) return rows
    return hasQuery && inScope('calls')
      ? rows.filter((r) => matchesRecentCall(r, trimmedQuery))
      : rows
  }, [recentCalls?.rows, matchesRecentCall, trimmedQuery, hasQuery, scope])
  // Single source of truth for "is this panel's filter active right now?" —
  // any of the four tables highlighting pulls the search-row container
  // into the same highlighted state, so the input area and the filtered
  // table read as one visual unit.
  const highlightByModel  = hasQuery && inScope('models')  && byModel.length > 0       && visibleByModel.length > 0
  const highlightErrors   = hasQuery && inScope('errors')  && errors.length > 0        && visibleErrors.length > 0
  const highlightByKey    = hasQuery && inScope('keys')    && byKey.length > 0         && visibleByKey.length > 0
  const highlightByCalls  = hasQuery && inScope('calls')   && (recentCalls?.rows?.length ?? 0) > 0 && (visibleRecentCalls?.length ?? 0) > 0
  const anyPanelHighlighted = highlightByModel || highlightErrors || highlightByKey || highlightByCalls

  const actualSavings = summary?.estimatedCostSavings ?? 0
  const baseSavings = summary30?.estimatedCostSavings ?? 0
  const spanDays = (() => {
    if (!summary30?.firstRequestAt) return 30
    // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
    const first = new Date(summary30.firstRequestAt.replace(' ', 'T') + 'Z').getTime()
    const days = (now - first) / 86_400_000
    if (!Number.isFinite(days)) return 30
    return Math.min(Math.max(days, 1 / 24), 30)
  })()
  const extrapolated = spanDays < 29.5
  const savings30d = extrapolated ? baseSavings * (30 / spanDays) : baseSavings
  const rangeLabel = range === '24h' ? t('analytics.rangeLabel24h')
    : range === '7d' ? t('analytics.rangeLabel7d')
    : range === '30d' ? t('analytics.rangeLabel30d')
    : t('analytics.rangeLabel90d')
  const spanLabel = spanDays >= 2 ? t('analytics.spanDays', { count: Math.round(spanDays) }) : t('analytics.spanHours', { count: Math.max(1, Math.round(spanDays * 24)) })
  const savingsHint = extrapolated
    ? t('analytics.savingsHint', { actual: actualSavings.toFixed(2), range: rangeLabel, span: spanLabel })
    : t('analytics.savingsHintExact', { actual: actualSavings.toFixed(2), range: rangeLabel })

  // Pinned = the client named a specific model instead of auto-routing.
  // Honored = that model actually served it (the rest failed over).
  const pinned = summary?.pinnedRequests ?? 0
  const pinHonored = summary?.pinHonoredRequests ?? 0
  const chatCount = summary?.requestTypeCounts?.chat ?? 0
  const embeddingCount = summary?.requestTypeCounts?.embedding ?? 0
  const requestsHint = (pinned > 0
    ? t('analytics.requestsHintPinned', { pinned, honored: pinHonored, failed: pinned - pinHonored })
    : t('analytics.requestsHintAuto'))
    + ' ' + t('analytics.requestsHintTypes', { chat: chatCount, embedding: embeddingCount })

  // Avg time-to-first-token is null when nothing streamed (or the raw window
  // was pruned); show a placeholder glyph rather than a misleading "0 ms".
  const avgTtfb = summary?.avgTtfbMs
  const ttftValue = avgTtfb != null ? `${avgTtfb} ms` : '—'

  // p95 latency is likewise null when the raw window was pruned; the server
  // does NOT coerce it (unlike avg latency), so a null must render the same
  // placeholder glyph instead of a misleading "0 ms".
  const p95Latency = summary?.p95LatencyMs
  const p95Value = p95Latency != null ? `${p95Latency} ms` : '—'

  // TTFT-by-provider is empty when no provider recorded a streaming first
  // token; render a muted line instead of an axis-only empty chart.
  const ttftHasData = byPlatform.some((p) => (p.avgTtfbMs ?? 0) > 0)

  return (
    <div className="analytics-viz">
      <style>{chartVars}</style>
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.description')}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Search row: input + scope chips, all sharing one rounded border.
                Mirrors the FallbackPage toolbar shape (#343). When any panel
                below is actively filtering (highlighted), the same
                primary-tinted ring animates around this whole container so
                the input area reads as part of the same visual unit. Same
                shadow + transition as the table panels, so the eye groups
                them as one. `w-56` covers ~25 chars of model/IP query. */}
            <div
              className={cn(
                "flex items-center gap-2 rounded-xl border bg-card px-2.5 py-1 transition-shadow duration-200",
                anyPanelHighlighted && "ring-2 ring-primary/50 shadow-lg shadow-primary/10"
              )}
            >
              <div className="relative flex-1 min-w-0 sm:w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t('models.searchPlaceholder')}
                  aria-label={t('analytics.searchAriaLabel')}
                  className="w-full bg-transparent py-1 pl-8 pr-7 text-sm outline-none"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    aria-label={t('models.clearSearch')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              {/* Scope chip strip. `role="group"` + `aria-label` so screen
                  readers announce "Filter scope" and treat the chips as a
                  single radiogroup. Each chip is a real <button> (not a
                  div) so Tab + Space/Enter works. The selected chip uses
                  the same primary tint as the panel ring, tying the
                  "active filter" cue across the toolbar and the table. */}
              <div
                role="group"
                aria-label={t('analytics.searchScopeAriaLabel')}
                className="flex items-center gap-1 pl-2 border-l"
              >
                {(['all', 'models', 'calls', 'errors', 'keys'] as const).map(s => {
                  const isActive = scope === s
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setScope(s)}
                      aria-pressed={isActive}
                      className={cn(
                        "rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors",
                        isActive
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"
                      )}
                    >
                      {t(s === 'all' ? 'analytics.searchScopeAll'
                           : s === 'models' ? 'analytics.searchScopeModels'
                           : s === 'calls' ? 'analytics.searchScopeCalls'
                           : s === 'errors' ? 'analytics.searchScopeErrors'
                           : 'analytics.searchScopeKeys')}
                    </button>
                  )
                })}
              </div>
            </div>
            <SegmentedControl
              value={range}
              onValueChange={setRange}
              options={(['24h', '7d', '30d', '90d'] as TimeRange[]).map(r => ({
                value: r,
                label: t(r === '24h' ? 'analytics.range24h' : r === '7d' ? 'analytics.range7d' : r === '30d' ? 'analytics.range30d' : 'analytics.range90d'),
              }))}
              ariaLabel={t('analytics.title')}
            />
          </div>
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-4 gap-3">
          {summaryLoading ? (
            Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-3xl" />)
          ) : (
            <>
              <Stat label={t('analytics.requests')} value={summary?.totalRequests ?? 0} hint={requestsHint} />
              <Stat label={t('analytics.successRate')} value={`${summary?.successRate ?? 0}%`} />
              <Stat label={t('analytics.inputTokens')} value={formatTokens(summary?.totalInputTokens)} />
              <Stat label={t('analytics.outputTokens')} value={formatTokens(summary?.totalOutputTokens)} />
              <Stat label={t('analytics.avgLatency')} value={`${summary?.avgLatencyMs ?? 0} ms`} />
              <Stat label={t('analytics.p95Latency')} value={p95Value} />
              <Stat label={t('analytics.avgTtft')} value={ttftValue} />
              {/* Priced per request at the served model's paid-API equivalent
                  rate (not a flat frontier-model rate) — see db/model-pricing.ts.
                  The value is a 30-day projection; the hover hint tells the whole
                  story (actual period amount + whether it was extrapolated). */}
              <Stat label={t('analytics.estSavings')} value={`$${savings30d.toFixed(2)}`} hint={savingsHint} />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="lg:col-span-2">
            <Panel title={t('analytics.requestsOverTime')}>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name={t('common.success')} stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name={t('common.failures')} stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          {/* Tokens over time: input vs output, one axis, two-series legend. */}
          <div className="lg:col-span-2">
            <Panel title={t('analytics.tokensOverTime')}>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatTokens(v)} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatTokens(Number(value))} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="inputTokens" name={t('analytics.inputTokens')} stroke={seriesA} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="outputTokens" name={t('analytics.outputTokens')} stroke={seriesB} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <Panel title={t('analytics.requestsByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="requests" name={t('analytics.requests')} fill={primaryFill} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Latency by provider: grouped avg + p95, same unit (ms), one axis. */}
          <Panel title={t('analytics.avgLatencyByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
                  <Bar dataKey="avgLatencyMs" name={t('analytics.avgLatency')} fill={seriesA} radius={[3, 3, 0, 0]} maxBarSize={24} />
                  <Bar dataKey="p95LatencyMs" name={t('analytics.p95Latency')} fill={seriesB} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Time to first token by provider (single series → no legend). */}
          <Panel title={t('analytics.ttftByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : !ttftHasData ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.ttftEmpty')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="avgTtfbMs" name={t('analytics.avgTtft')} fill={seriesA} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Errors by category: horizontal bars, destructive hue, no legend. */}
          <Panel title={t('analytics.errorDistribution')}>
            {!errorDist?.byCategory?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byCategory} layout="vertical" margin={{ top: 6, right: 12, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} allowDecimals={false} />
                  <YAxis type="category" dataKey="category" tick={axisStyle} tickLine={false} axisLine={false} width={128} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name={t('analytics.errors')} fill="var(--destructive)" radius={[0, 3, 3, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title={t('analytics.errorsByProvider')}>
            {!errorDist?.byPlatform?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name={t('analytics.errors')} fill="var(--destructive)" radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel
            title={t('analytics.recentErrors')}
            highlighted={highlightErrors}
            countLabel={highlightErrors ? t('analytics.matchedCount', { shown: visibleErrors.length, total: errors.length }) : undefined}
          >
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : visibleErrors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noMatches')}</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{t('common.provider')}</TableHead>
                      <TableHead>{t('analytics.message')}</TableHead>
                      <TableHead className="text-right pr-4">{t('analytics.time')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleErrors.slice(0, 20).map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">{e.error}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {formatSqliteUtcToLocalTime(e.createdAt, { hour: '2-digit', minute: '2-digit' })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>

          {/* Recent calls: one line per proxied request with the caller's IP +
              user agent. All local clients share the unified key, so this is
              the only view that answers "who is hitting the router". */}
          <div className="lg:col-span-2">
            <Panel
              title={t('analytics.recentCalls')}
              highlighted={highlightByCalls}
              countLabel={highlightByCalls ? t('analytics.matchedCount', { shown: visibleRecentCalls?.length ?? 0, total: recentCalls?.rows?.length ?? 0 }) : undefined}
            >
              {!recentCalls?.rows?.length ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (visibleRecentCalls?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noMatches')}</p>
              ) : (
                <div className="max-h-[420px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('analytics.time')}</TableHead>
                        <TableHead>{t('analytics.clientIp')}</TableHead>
                        <TableHead>{t('analytics.clientAgent')}</TableHead>
                        <TableHead>{t('common.model')}</TableHead>
                        <TableHead>{t('common.provider')}</TableHead>
                        <TableHead>{t('common.status')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.latency')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(visibleRecentCalls ?? []).map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="pl-4 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                            {formatSqliteUtcToLocalTime(r.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </TableCell>
                          <TableCell className="text-xs font-medium tabular-nums">{r.clientIp ?? '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground" title={r.clientUserAgent ?? undefined}>
                            {shortUserAgent(r.clientUserAgent)}
                          </TableCell>
                          <TableCell className="text-xs max-w-[220px] truncate" title={r.requestedModel && r.requestedModel !== r.modelId ? t('analytics.requestedModelHint', { model: r.requestedModel }) : undefined}>
                            {r.modelId}
                            {r.requestedModel && r.requestedModel !== r.modelId ? ' *' : ''}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.platform}</TableCell>
                          <TableCell className={`text-xs ${r.status === 'success' ? 'text-muted-foreground' : 'text-destructive'}`} title={r.error ?? undefined}>
                            {r.status}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatTokens(r.inputTokens)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatTokens(r.outputTokens)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums pr-4">{r.latencyMs} ms</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel
              title={t('analytics.perModelBreakdown')}
              highlighted={highlightByModel}
              countLabel={highlightByModel ? t('analytics.matchedCount', { shown: visibleByModel.length, total: byModel.length }) : undefined}
            >
              {byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : visibleByModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noMatches')}</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('common.model')}</TableHead>
                        <TableHead>{t('common.provider')}</TableHead>
                        <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                        <TableHead className="text-right">{t('analytics.pinned')}</TableHead>
                        <TableHead className="text-right">{t('common.success')}</TableHead>
                        <TableHead className="text-right">{t('analytics.latency')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.saved')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleByModel.map((m, i) => (
                        <TableRow key={i}>
                          <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.pinnedRequests > 0 ? m.pinnedRequests : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalOutputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">${(m.estimatedCost ?? 0).toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          {/* Usage by key: only rendered when the endpoint returns rows. */}
          {byKey.length > 0 && (
            <div className="lg:col-span-2">
              <Panel
                title={t('analytics.usageByKey')}
                highlighted={highlightByKey}
                countLabel={highlightByKey ? t('analytics.matchedCount', { shown: visibleByKey.length, total: byKey.length }) : undefined}
              >
                {visibleByKey.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noMatches')}</p>
                ) : (
                  <div className="max-h-[360px] overflow-y-auto -mx-4">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">{t('analytics.keyColumn')}</TableHead>
                          <TableHead>{t('common.provider')}</TableHead>
                          <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                          <TableHead className="text-right">{t('common.success')}</TableHead>
                          <TableHead className="text-right">{t('analytics.latency')}</TableHead>
                          <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                          <TableHead className="text-right pr-4">{t('analytics.outTokens')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleByKey.map((k) => (
                          <TableRow key={k.keyId}>
                            <TableCell className="pl-4 text-sm font-medium">
                              {k.label || t('analytics.keyLabelFallback', { id: k.keyId })}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{k.platform ?? '—'}</TableCell>
                            <TableCell className="text-right tabular-nums">{k.requests}</TableCell>
                            <TableCell className="text-right tabular-nums">{k.successRate}%</TableCell>
                            <TableCell className="text-right tabular-nums">{k.avgLatencyMs} ms</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(k.totalInputTokens)}</TableCell>
                            <TableCell className="text-right tabular-nums pr-4">{formatTokens(k.totalOutputTokens)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Panel>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
