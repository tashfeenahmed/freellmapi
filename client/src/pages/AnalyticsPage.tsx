import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  ChartLine,
  CheckCircle2,
  CircleAlert,
  CircleDollarSign,
  Clock,
  Coins,
  Gauge,
  GitBranch,
  KeyRound,
  Layers,
  List,
  Network,
  Server,
  TriangleAlert,
  Zap,
  X,
  type LucideIcon,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip as HoverTooltip } from '@/components/tooltip'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { platformColors } from '@/lib/routing'
import { useI18n } from '@/i18n'

type TimeRange = '24h' | '7d' | '30d' | '90d'

const TIME_RANGES: TimeRange[] = ['24h', '7d', '30d', '90d']

// The range toggle sticks: whichever window you last looked at is the one the
// tab opens with next time, instead of always snapping back to 7d (#711).
const RANGE_KEY = 'analytics.range'

function storedRange(): TimeRange {
  try {
    const v = localStorage.getItem(RANGE_KEY)
    if (v && (TIME_RANGES as string[]).includes(v)) return v as TimeRange
  } catch { /* ignore */ }
  return '7d'
}

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

interface ByClientRow {
  clientAgent: string
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
  lastSeenAt: string | null
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
  // Failover-ladder length: attempts hang off the TERMINAL row of a proxied
  // request, so mid-ladder failure rows report 0.
  attemptCount: number
}

interface RecentCallsResponse {
  total: number
  rows: RecentCallRow[]
}

// One hop of the failover ladder, from GET /api/analytics/requests/:id.
interface RequestAttempt {
  ordinal: number
  platform: string
  modelId: string
  keyOrdinal: number
  outcome: string
  startOffsetMs: number
  durationMs: number
  errorSummary: string | null
}

interface RequestDetail extends Omit<RecentCallRow, 'attemptCount'> {
  ttfbMs: number | null
  attempts: RequestAttempt[]
}

type StatusFilter = 'all' | 'success' | 'error' | 'canceled'

// 'canceled' (#752 — the client hung up mid-request) is neither success nor
// error: neutral amber, not destructive red.
function statusTextClass(status: string): string {
  if (status === 'success') return 'text-muted-foreground'
  if (status === 'canceled') return 'text-amber-600 dark:text-amber-400'
  return 'text-destructive'
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

function Stat({ icon: Icon, label, value, hint, className }: { icon: LucideIcon; label: string; value: string | number; hint?: string; className?: string }) {
  const card = (
    <div className="rounded-3xl border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
      </div>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
  // Same portal tooltip as the routing strategy chips. Opens BELOW the card:
  // the stats row sits right under the sticky navbar.
  return hint ? <HoverTooltip text={hint} side="bottom" className="block">{card}</HoverTooltip> : card
}

function Panel({ icon: Icon, title, actions, children }: { icon: LucideIcon; title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          {title}
        </h3>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

// ── ComboAnalyticsCard ────────────────────────────────────────────────────

function ComboAnalyticsCard({ combo }: {
  combo: {
    comboName: string
    totalRequests: number
    successRate: number
    avgLatencyMs: number
    totalInputTokens: number
    totalOutputTokens: number
    modelDistribution: Array<{
      modelId: string
      count: number
      pct: number
      avgLatencyMs: number
      successRate: number
    }>
    fallbackDepth: Array<{
      ordinal: number
      modelId: string
      count: number
      pct: number
    }>
  }
}) {
  const { t } = useI18n()

  return (
    <div className="rounded-xl border p-4 space-y-4">
      {/* Summary row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{combo.comboName}</h3>
          <p className="text-xs text-muted-foreground">
            {combo.totalRequests} requests · {combo.successRate}% success · {combo.avgLatencyMs} ms avg
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
          <span>↑ {formatTokens(combo.totalInputTokens)}</span>
          <span>↓ {formatTokens(combo.totalOutputTokens)}</span>
        </div>
      </div>

      {/* Model distribution bar */}
      {combo.modelDistribution.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            {t('analytics.modelDistribution') || 'Model distribution'}
          </p>
          <div className="flex h-5 rounded-full overflow-hidden text-[10px] font-medium">
            {combo.modelDistribution.map((m, i) => (
              <div
                key={m.modelId}
                style={{
                  width: `${m.pct}%`,
                  backgroundColor: `hsl(${i * 45 + 200}, 55%, ${55 - i * 5}%)`,
                }}
                className="flex items-center justify-center text-white/90 last:rounded-r-full first:rounded-l-full min-w-[2px]"
                title={`${m.modelId}: ${m.pct}% (${m.count} req, ${m.successRate}% success)`}
              >
                {m.pct > 12 ? m.modelId.split('/').pop()?.split('-').slice(0, 2).join('-') : ''}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            {combo.modelDistribution.map((m, i) => (
              <span key={m.modelId} className="flex items-center gap-1">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: `hsl(${i * 45 + 200}, 55%, 55%)` }}
                />
                {m.modelId}: {m.pct}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Fallback depth bar */}
      {combo.fallbackDepth.length > 1 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            {t('analytics.fallbackDepth') || 'Fallback depth'}
          </p>
          <div className="flex h-4 rounded-full overflow-hidden text-[10px] font-medium">
            {combo.fallbackDepth.map((f, i) => (
              <div
                key={f.ordinal}
                style={{
                  width: `${f.pct}%`,
                  backgroundColor: i === 0 ? '#22c55e' : i === 1 ? '#f59e0b' : '#ef4444',
                }}
                className="flex items-center justify-center text-white/90 last:rounded-r-full first:rounded-l-full min-w-[8px]"
                title={`Attempt ${f.ordinal} (${f.modelId}): ${f.pct}%`}
              >
                {f.pct > 10 ? `#${f.ordinal}` : ''}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            {combo.fallbackDepth.map((f, i) => (
              <span key={f.ordinal} className="flex items-center gap-1">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: i === 0 ? '#22c55e' : i === 1 ? '#f59e0b' : '#ef4444' }}
                />
                #{f.ordinal} ({f.modelId}): {f.pct}%
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Platform swatch shared by the ladder and the per-provider table; same color
// source as the token-usage legend (lib/routing.ts), same gray fallback.
function PlatformDot({ platform }: { platform: string }) {
  return (
    <span
      className="size-2 rounded-full flex-shrink-0"
      style={{ backgroundColor: platformColors[platform] ?? '#94a3b8' }}
    />
  )
}

// Compact ms rendering for ladder timings: sub-second stays in ms, longer
// spans read as seconds ("38.8 s") like the issue reports do.
function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`
  return `${ms} ms`
}

// Key/value line of the request-detail summary grid.
function DetailField({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-sm mt-0.5 break-words ${mono ? 'tabular-nums' : ''}`}>{value}</p>
    </div>
  )
}

// Per-request drill-down: the parent row's fields plus the failover ladder —
// one entry per dispatched attempt (ordinal → provider/model → key ordinal →
// outcome → timing, with the redacted per-hop error when one was recorded).
// A dialog (the app's detail-popup idiom, cf. keys/export-keys-dialog) rather
// than a routed page so the list's range/filter context stays put behind it.
function RequestDetailDialog({ requestId, onClose }: { requestId: number | null; onClose: () => void }) {
  const { t } = useI18n()

  const { data: detail, isLoading } = useQuery({
    queryKey: ['analytics', 'request-detail', requestId],
    queryFn: () => apiFetch<RequestDetail>(`/api/analytics/requests/${requestId}`),
    enabled: requestId != null,
  })

  return (
    <Dialog open={requestId != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPopup maxWidth="max-w-2xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
            <DialogTitle>{t('analytics.requestDetailTitle', { id: requestId ?? '' })}</DialogTitle>
          </div>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        {isLoading || !detail ? (
          <div className="space-y-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
              <DetailField
                label={t('analytics.time')}
                value={formatSqliteUtcToLocalTime(detail.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                mono
              />
              <DetailField
                label={t('common.status')}
                value={
                  <span className={detail.status === 'success' ? '' : statusTextClass(detail.status)}>{detail.status}</span>
                }
              />
              <DetailField
                label={t('common.provider')}
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <PlatformDot platform={detail.platform} />
                    {detail.platform}
                  </span>
                }
              />
              <DetailField label={t('common.model')} value={detail.modelId} />
              {detail.requestedModel && detail.requestedModel !== detail.modelId && (
                <DetailField label={t('analytics.requestedModel')} value={detail.requestedModel} />
              )}
              <DetailField
                label={`${t('analytics.inTokens')} / ${t('analytics.outTokens')}`}
                value={`${formatTokens(detail.inputTokens)} / ${formatTokens(detail.outputTokens)}`}
                mono
              />
              <DetailField label={t('analytics.latency')} value={formatMs(detail.latencyMs ?? 0)} mono />
              <DetailField label={t('analytics.ttft')} value={detail.ttfbMs != null ? formatMs(detail.ttfbMs) : '—'} mono />
              <DetailField label={t('analytics.clientIp')} value={detail.clientIp ?? '—'} mono />
              <DetailField label={t('analytics.clientAgent')} value={detail.clientUserAgent ?? '—'} />
            </div>

            {detail.error && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-[11px] text-destructive uppercase tracking-wider">{t('analytics.message')}</p>
                <p className="text-xs text-destructive/90 mt-1 break-words">{detail.error}</p>
              </div>
            )}

            <div>
              <h4 className="flex items-center gap-2 text-sm font-medium">
                <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
                {t('analytics.failoverLadder')}
              </h4>
              <p className="text-xs text-muted-foreground mt-0.5">{t('analytics.failoverLadderHint')}</p>
              {detail.attempts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">{t('analytics.noAttemptTrace')}</p>
              ) : (
                <ol className="mt-3 space-y-2">
                  {detail.attempts.map((a) => (
                    <li key={a.ordinal} className="rounded-xl border px-3 py-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="w-6 text-muted-foreground tabular-nums">#{a.ordinal + 1}</span>
                        <PlatformDot platform={a.platform} />
                        <span className="font-medium">{a.platform}</span>
                        <span className="text-muted-foreground truncate" title={a.modelId}>{a.modelId}</span>
                        <Badge variant="outline">{t('analytics.keyOrdinal', { n: a.keyOrdinal })}</Badge>
                        {/* client_abort is the caller's doing, not a hop failure. */}
                        <Badge variant={a.outcome === 'ok' || a.outcome === 'committed' ? 'secondary' : a.outcome === 'client_abort' ? 'outline' : 'destructive'}>
                          {a.outcome}
                        </Badge>
                        <span
                          className="ml-auto whitespace-nowrap text-muted-foreground tabular-nums"
                          title={t('analytics.attemptTimingHint')}
                        >
                          +{formatMs(a.startOffsetMs)} · {formatMs(a.durationMs)}
                        </span>
                      </div>
                      {a.errorSummary && (
                        <p className="mt-1 pl-8 text-xs text-destructive/90 break-words">{a.errorSummary}</p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </DialogPopup>
    </Dialog>
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

export default function AnalyticsPage() {
  const { t } = useI18n()
  const [range, setRange] = useState<TimeRange>(storedRange)
  const updateRange = (r: TimeRange) => {
    setRange(r)
    try { localStorage.setItem(RANGE_KEY, r) } catch { /* ignore */ }
  }
  // Capture "now" once at mount so the savings extrapolation below stays a pure
  // render (calling Date.now() during render is impure and non-deterministic).
  const [now] = useState(() => Date.now())

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<SummaryResponse>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<ByPlatformRow[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: byClient = [] } = useQuery({
    queryKey: ['analytics', 'by-client', range],
    queryFn: () => apiFetch<ByClientRow[]>(`/api/analytics/by-client?range=${range}`),
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

  // Recent-calls list filters (status/platform) + the row opened in the
  // drill-down dialog. Filters ride the query key so react-query refetches
  // (and caches) each combination on its own.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  const [requestTypeFilter, setRequestTypeFilter] = useState<string>('all')
  const { data: combosList } = useQuery({
    queryKey: ['combos'],
    queryFn: () => apiFetch<{ combos: Array<{ name: string; strategy: string }> }>('/api/combos'),
  })
  const [detailId, setDetailId] = useState<number | null>(null)

  const { data: recentCalls } = useQuery({
    queryKey: ['analytics', 'requests', range, statusFilter, platformFilter, requestTypeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ range, limit: '100' })
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (platformFilter !== 'all') params.set('platform', platformFilter)
      if (requestTypeFilter !== 'all') params.set('requested_model', requestTypeFilter)
      return apiFetch<RecentCallsResponse>(`/api/analytics/requests?${params}`)
    },
  })

  const requestTypeOptions = useMemo(() => {
    const comboNames = (combosList?.combos ?? []).map(c => c.name).sort()
    return [
      { value: 'all', label: t('analytics.filterAll') },
      { value: 'auto', label: 'Auto' },
      { value: 'fusion', label: 'Fusion' },
      ...comboNames.map(name => ({ value: name, label: `Combo: ${name}` })),
    ]
  }, [combosList, t])

  const [showComboAnalytics, setShowComboAnalytics] = useState(false)
  const { data: comboAnalytics, isLoading: comboAnalyticsLoading } = useQuery({
    queryKey: ['analytics', 'by-combo', range],
    queryFn: () => apiFetch<{
      combos: Array<{
        comboName: string
        totalRequests: number
        successRate: number
        avgLatencyMs: number
        totalInputTokens: number
        totalOutputTokens: number
        modelDistribution: Array<{
          modelId: string
          count: number
          pct: number
          avgLatencyMs: number
          successRate: number
        }>
        fallbackDepth: Array<{
          ordinal: number
          modelId: string
          count: number
          pct: number
        }>
      }>
    }>(`/api/analytics/by-combo?range=${range}`),
    enabled: showComboAnalytics,
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
          <SegmentedControl
            value={range}
            onValueChange={updateRange}
            options={TIME_RANGES.map(r => ({
              value: r,
              label: t(r === '24h' ? 'analytics.range24h' : r === '7d' ? 'analytics.range7d' : r === '30d' ? 'analytics.range30d' : 'analytics.range90d'),
            }))}
            ariaLabel={t('analytics.title')}
          />
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-4 gap-3">
          {summaryLoading ? (
            Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-3xl" />)
          ) : (
            <>
              <Stat icon={Activity} label={t('analytics.requests')} value={summary?.totalRequests ?? 0} hint={requestsHint} />
              <Stat icon={CheckCircle2} label={t('analytics.successRate')} value={`${summary?.successRate ?? 0}%`} />
              <Stat icon={ArrowDown} label={t('analytics.inputTokens')} value={formatTokens(summary?.totalInputTokens)} />
              <Stat icon={ArrowUp} label={t('analytics.outputTokens')} value={formatTokens(summary?.totalOutputTokens)} />
              <Stat icon={Gauge} label={t('analytics.avgLatency')} value={`${summary?.avgLatencyMs ?? 0} ms`} />
              <Stat icon={Clock} label={t('analytics.p95Latency')} value={p95Value} />
              <Stat icon={Zap} label={t('analytics.avgTtft')} value={ttftValue} />
              {/* Priced per request at the served model's paid-API equivalent
                  rate (not a flat frontier-model rate) — see db/model-pricing.ts.
                  The value is a 30-day projection; the hover hint tells the whole
                  story (actual period amount + whether it was extrapolated). */}
              <Stat icon={CircleDollarSign} label={t('analytics.estSavings')} value={`$${savings30d.toFixed(2)}`} hint={savingsHint} />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="lg:col-span-2">
            <Panel icon={ChartLine} title={t('analytics.requestsOverTime')}>
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
            <Panel icon={Coins} title={t('analytics.tokensOverTime')}>
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

          <Panel icon={Server} title={t('analytics.requestsByProvider')}>
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

          <Panel icon={Bot} title={t('analytics.requestsByAgent')}>
            {byClient.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byClient} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="clientAgent" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="requests" name={t('analytics.requests')} fill={seriesB} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Latency by provider: grouped avg + p95, same unit (ms), one axis. */}
          <Panel icon={Gauge} title={t('analytics.avgLatencyByProvider')}>
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
          <Panel icon={Zap} title={t('analytics.ttftByProvider')}>
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
          <Panel icon={TriangleAlert} title={t('analytics.errorDistribution')}>
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

          <Panel icon={CircleAlert} title={t('analytics.errorsByProvider')}>
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

          <Panel icon={CircleAlert} title={t('analytics.recentErrors')}>
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
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
                    {errors.slice(0, 20).map((e) => (
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
              the only view that answers "who is hitting the router". Rows open
              the failover-ladder drill-down; the header hosts status/provider
              filters (server-side, so total reflects the filtered set). */}
          <div className="lg:col-span-2">
            <Panel
              icon={List}
              title={t('analytics.recentCalls')}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl
                    value={statusFilter}
                    onValueChange={setStatusFilter}
                    options={[
                      { value: 'all', label: t('analytics.filterAll') },
                      { value: 'success', label: t('common.success') },
                      { value: 'error', label: t('analytics.errors') },
                      { value: 'canceled', label: t('analytics.filterCanceled') },
                    ]}
                    ariaLabel={t('common.status')}
                  />
                  <Select value={platformFilter} onValueChange={(v) => setPlatformFilter(v ?? 'all')}>
                    <SelectTrigger size="sm" aria-label={t('common.provider')}>
                      <SelectValue>
                        {(v: string) => (!v || v === 'all' ? t('analytics.allProviders') : v)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('analytics.allProviders')}</SelectItem>
                      {byPlatform.map((p) => (
                        <SelectItem key={p.platform} value={p.platform}>
                          <span className="flex items-center gap-2">
                            <PlatformDot platform={p.platform} />
                            <span>{p.platform}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={requestTypeFilter} onValueChange={(v) => setRequestTypeFilter(v ?? 'all')}>
                    <SelectTrigger size="sm" aria-label="Request type">
                      <SelectValue>
                        {(v: string) => {
                          if (!v || v === 'all') return t('analytics.filterAll')
                          if (v === 'auto') return 'Auto'
                          if (v === 'fusion') return 'Fusion'
                          return `Combo: ${v}`
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {requestTypeOptions.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              }
            >
              {!recentCalls?.rows?.length ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <div className="max-h-[420px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('analytics.time')}</TableHead>
                        <TableHead>{t('analytics.clientIp')}</TableHead>
                        <TableHead>{t('analytics.clientAgent')}</TableHead>
                        <TableHead>{t('common.model')}</TableHead>
                        <TableHead>{t('analytics.requestType') || 'Type'}</TableHead>
                        <TableHead>{t('common.provider')}</TableHead>
                        <TableHead>{t('common.status')}</TableHead>
                        <TableHead className="text-right">{t('analytics.attempts')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.latency')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentCalls.rows.map((r) => (
                        <TableRow
                          key={r.id}
                          onClick={() => setDetailId(r.id)}
                          className="cursor-pointer"
                        >
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
                          <TableCell className="text-xs">
                            {r.requestedModel === null || r.requestedModel === r.modelId ? (
                              <span className="text-muted-foreground">—</span>
                            ) : r.requestedModel === 'auto' ? (
                              <Badge variant="outline" className="text-[10px] font-mono">Auto</Badge>
                            ) : r.requestedModel === 'fusion' ? (
                              <Badge variant="outline" className="text-[10px] font-mono">Fusion</Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px] font-mono" title={`Combo: ${r.requestedModel}`}>
                                {r.requestedModel}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.platform}</TableCell>
                          <TableCell className={`text-xs ${statusTextClass(r.status)}`} title={r.error ?? undefined}>
                            {r.status}
                          </TableCell>
                          {/* >1 = the request burned failover hops; that is the
                              row worth drilling into, so give it weight. */}
                          <TableCell className={`text-right text-xs tabular-nums ${r.attemptCount > 1 ? 'font-medium' : 'text-muted-foreground'}`}>
                            {r.attemptCount > 0 ? r.attemptCount : '—'}
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

          {/* Per-provider breakdown: the tabular face of the by-platform data —
              the charts above show volume/latency, this row surfaces the
              success-rate and error-count numbers (#335). */}
          <div className="lg:col-span-2">
            <Panel icon={Network} title={t('analytics.providerBreakdown')}>
              {byPlatform.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('common.provider')}</TableHead>
                        <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                        <TableHead className="text-right">{t('common.success')}</TableHead>
                        <TableHead className="text-right">{t('analytics.errors')}</TableHead>
                        <TableHead className="text-right">{t('analytics.avgLatency')}</TableHead>
                        <TableHead className="text-right">{t('analytics.p95Latency')}</TableHead>
                        <TableHead className="text-right">{t('analytics.avgTtft')}</TableHead>
                        <TableHead className="text-right">{t('analytics.tokensPerSec')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.outTokens')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byPlatform.map((p) => (
                        <TableRow key={p.platform}>
                          <TableCell className="pl-4 text-sm font-medium">
                            <span className="flex items-center gap-2">
                              <PlatformDot platform={p.platform} />
                              {p.platform}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{p.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.successRate}%</TableCell>
                          <TableCell className={`text-right tabular-nums ${p.errorCount > 0 ? 'text-destructive' : ''}`}>
                            {p.errorCount > 0 ? p.errorCount : '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{p.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{p.p95LatencyMs != null ? `${p.p95LatencyMs} ms` : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.avgTtfbMs != null ? `${p.avgTtfbMs} ms` : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.avgTokensPerSecond != null ? p.avgTokensPerSecond : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(p.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">{formatTokens(p.totalOutputTokens)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel icon={Layers} title={t('analytics.perModelBreakdown')}>
              {byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
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
                      {byModel.map((m, i) => (
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
              <Panel icon={KeyRound} title={t('analytics.usageByKey')}>
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
                      {byKey.map((k) => (
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
              </Panel>
            </div>
          )}

          {/* ── Combo Analytics (collapsible) ── */}
          <div className="lg:col-span-2">
            <Panel
              title={`${t('analytics.comboAnalytics') || 'Combo Analytics'}`}
              actions={
                <button
                  type="button"
                  onClick={() => setShowComboAnalytics(v => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showComboAnalytics ? (t('common.hide') || 'Hide') : (t('common.show') || 'Show')}
                </button>
              }
            >
              {!showComboAnalytics ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  {t('analytics.comboAnalyticsHint') || 'Click Show to view per-combo breakdown.'}
                </p>
              ) : comboAnalyticsLoading ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.loading')}</p>
              ) : !comboAnalytics?.combos?.length ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  {t('analytics.noComboData') || 'No combo requests yet — use a combo model in chat, then come back.'}
                </p>
              ) : (
                <div className="space-y-6">
                  {comboAnalytics.combos.map(combo => (
                    <ComboAnalyticsCard key={combo.comboName} combo={combo} />
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </div>
      </div>

      <RequestDetailDialog requestId={detailId} onClose={() => setDetailId(null)} />
    </div>
  )
}
