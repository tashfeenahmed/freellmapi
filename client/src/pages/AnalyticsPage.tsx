import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip as HoverTooltip } from '@/components/tooltip'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-medium">{title}</h3>
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

export default function AnalyticsPage() {
  const { t } = useI18n()
  const [range, setRange] = useState<TimeRange>('7d')
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
            onValueChange={setRange}
            options={(['24h', '7d', '30d', '90d'] as TimeRange[]).map(r => ({
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

          <Panel title={t('analytics.recentErrors')}>
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
              the only view that answers "who is hitting the router". */}
          <div className="lg:col-span-2">
            <Panel title={t('analytics.recentCalls')}>
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
                        <TableHead>{t('common.provider')}</TableHead>
                        <TableHead>{t('common.status')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.latency')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentCalls.rows.map((r) => (
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
            <Panel title={t('analytics.perModelBreakdown')}>
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
              <Panel title={t('analytics.usageByKey')}>
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
        </div>
      </div>
    </div>
  )
}
