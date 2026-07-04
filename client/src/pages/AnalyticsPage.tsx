import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { Tooltip as HoverTooltip } from '@/components/tooltip'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useI18n } from '@/i18n'

type TimeRange = '24h' | '7d' | '30d'

const TIME_RANGES: readonly TimeRange[] = ['24h', '7d', '30d']
const STORAGE_KEY = 'freellmapi.analytics.range'
const DEFAULT_RANGE: TimeRange = '7d'

// Read the previously-selected range from localStorage. Invalid or missing
// values fall back to the 7d default so a corrupted entry never bricks the
// page; SSR-safety follows the same try/catch shape as `lib/api.ts`.
function loadStoredRange(): TimeRange {
  if (typeof window === 'undefined') return DEFAULT_RANGE
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && (TIME_RANGES as readonly string[]).includes(stored)) {
      return stored as TimeRange
    }
  } catch {
    /* localStorage unavailable (private mode, etc.) — use default */
  }
  return DEFAULT_RANGE
}

// Per-model table sort state. The `pinned` column is intentionally NOT
// sortable — it renders "—" for zero-pinned rows and the unsortable `0`/`>0`
// distinction would confuse the indicator. 3-state cycle per column:
// null → asc → desc → null. Switching to a new column resets to asc.
type SortColumn = 'model' | 'provider' | 'requests' | 'success' | 'latency' | 'inTokens' | 'outTokens' | 'saved'
type SortDirection = 'asc' | 'desc'
type SortState = { column: SortColumn; direction: SortDirection } | null

const SORT_COLUMNS: readonly SortColumn[] = [
  'model', 'provider', 'requests', 'success', 'latency', 'inTokens', 'outTokens', 'saved',
]
const SORT_STORAGE_KEY = 'freellmapi.analytics.byModelSort'

function loadStoredSort(): SortState {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { column?: unknown; direction?: unknown }
    if (
      typeof parsed.column === 'string' &&
      (SORT_COLUMNS as readonly string[]).includes(parsed.column) &&
      (parsed.direction === 'asc' || parsed.direction === 'desc')
    ) {
      return { column: parsed.column as SortColumn, direction: parsed.direction }
    }
  } catch {
    /* corrupted JSON or storage unavailable — fall through to null */
  }
  return null
}

// Numeric accessor for a sortable column. Returns null for values the API
// didn't include so they sort to the bottom on asc and top on desc.
function sortValue(row: any, col: SortColumn): number | string | null {
  switch (col) {
    case 'model': return row.displayName ?? null
    case 'provider': return row.platform ?? null
    case 'requests': return row.requests ?? null
    case 'success': return row.successRate ?? null
    case 'latency': return row.avgLatencyMs ?? null
    case 'inTokens': return row.totalInputTokens ?? null
    case 'outTokens': return row.totalOutputTokens ?? null
    case 'saved': return row.estimatedCost ?? null
  }
}

function compareRows(a: any, b: any, col: SortColumn): number {
  const av = sortValue(a, col)
  const bv = sortValue(b, col)
  // Nulls always last regardless of direction (Excel/Sheets convention).
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  if (typeof av === 'number' && typeof bv === 'number') return av - bv
  return String(av).localeCompare(String(bv))
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

// Sortable header cell. Renders the label + a state-aware indicator:
// unsorted → ChevronsUpDown (faded), asc → ArrowUp, desc → ArrowDown.
// Right-aligned columns flip the indicator order so it sits to the LEFT
// of the label, keeping the label closest to the data.
function SortableHeader({
  column,
  label,
  align,
  extraClass,
  sort,
  onClick,
}: {
  column: SortColumn
  label: string
  align: 'left' | 'right'
  extraClass?: string
  sort: SortState
  onClick: (col: SortColumn) => void
}) {
  const active = sort?.column === column
  const direction = active ? sort.direction : null
  const indicator = direction === 'asc'
    ? <ArrowUp className="size-3 shrink-0" />
    : direction === 'desc'
    ? <ArrowDown className="size-3 shrink-0" />
    : <ChevronsUpDown className="size-3 shrink-0 opacity-40" />
  const alignClass = align === 'right' ? 'text-right' : ''
  const headClass = [alignClass, extraClass].filter(Boolean).join(' ')
  return (
    <TableHead className={headClass || undefined}>
      <button
        type="button"
        onClick={() => onClick(column)}
        aria-label={label}
        aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
        className={
          'inline-flex items-center gap-1 ' +
          (align === 'right' ? 'flex-row-reverse' : 'flex-row') +
          ' cursor-pointer select-none hover:text-foreground transition-colors ' +
          (active ? 'text-foreground' : 'text-muted-foreground')
        }
      >
        <span>{label}</span>
        {indicator}
      </button>
    </TableHead>
  )
}

export default function AnalyticsPage() {
  const { t } = useI18n()
  const [range, setRange] = useState<TimeRange>(loadStoredRange)

  // Remember the last-selected range across page reloads / new sessions so
  // the user lands back on the window they were inspecting. Same
  // localStorage shape as `theme` and `freellmapi.locale`.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, range)
    } catch {
      /* ignore — storage quota / private mode */
    }
  }, [range])

  // Per-model table sort. Cycle: null → asc → desc → null. Switching column
  // starts at asc on the new column. Persisted so the next visit lands on
  // the user's preferred sort.
  const [sort, setSort] = useState<SortState>(loadStoredSort)
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (sort === null) window.localStorage.removeItem(SORT_STORAGE_KEY)
      else window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort))
    } catch {
      /* ignore */
    }
  }, [sort])

  const onHeaderClick = (col: SortColumn) => {
    setSort((current) => {
      if (!current || current.column !== col) return { column: col, direction: 'asc' }
      if (current.direction === 'asc') return { column: col, direction: 'desc' }
      return null // third click on the same column → restore API order
    })
  }

  const { data: summary } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<any>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/timeline?range=${range}`),
  })

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/by-model?range=${range}`),
  })

  // Apply the user's sort to byModel. When sort is null we render the rows
  // in API-returned order; the API's natural ordering (requests DESC) is
  // the right default. The sort is stable within the comparator because we
  // fall back to insertion order for equal values (Array.prototype.sort is
  // stable in all modern engines).
  const sortedByModel = useMemo(() => {
    if (!sort) return byModel
    const copy = byModel.slice()
    copy.sort((a, b) => {
      const primary = compareRows(a, b, sort.column)
      return sort.direction === 'asc' ? primary : -primary
    })
    return copy
  }, [byModel, sort])

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/errors?range=${range}`),
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<{ byCategory: any[]; byPlatform: any[]; detailed: any[] }>(`/api/analytics/error-distribution?range=${range}`),
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
    queryFn: () => apiFetch<any>(`/api/analytics/summary?range=30d`),
  })
  const actualSavings = summary?.estimatedCostSavings ?? 0
  const baseSavings = summary30?.estimatedCostSavings ?? 0
  const spanDays = (() => {
    if (!summary30?.firstRequestAt) return 30
    // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
    const first = new Date(summary30.firstRequestAt.replace(' ', 'T') + 'Z').getTime()
    const days = (Date.now() - first) / 86_400_000
    if (!Number.isFinite(days)) return 30
    return Math.min(Math.max(days, 1 / 24), 30)
  })()
  const extrapolated = spanDays < 29.5
  const savings30d = extrapolated ? baseSavings * (30 / spanDays) : baseSavings
  const rangeLabel = range === '24h' ? t('analytics.rangeLabel24h') : range === '7d' ? t('analytics.rangeLabel7d') : t('analytics.rangeLabel30d')
  const spanLabel = spanDays >= 2 ? t('analytics.spanDays', { count: Math.round(spanDays) }) : t('analytics.spanHours', { count: Math.max(1, Math.round(spanDays * 24)) })
  const savingsHint = extrapolated
    ? t('analytics.savingsHint', { actual: actualSavings.toFixed(2), range: rangeLabel, span: spanLabel })
    : t('analytics.savingsHintExact', { actual: actualSavings.toFixed(2), range: rangeLabel })

  // Pinned = the client named a specific model instead of auto-routing.
  // Honored = that model actually served it (the rest failed over).
  const pinned = summary?.pinnedRequests ?? 0
  const pinHonored = summary?.pinHonoredRequests ?? 0
  const requestsHint = pinned > 0
    ? t('analytics.requestsHintPinned', { pinned, honored: pinHonored, failed: pinned - pinHonored })
    : t('analytics.requestsHintAuto')

  return (
    <div>
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.description')}
        actions={
          <div className="flex gap-1 rounded-lg border p-0.5">
            {(['24h', '7d', '30d'] as TimeRange[]).map(r => (
              <Button
                key={r}
                variant={range === r ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setRange(r)}
              >
                {t(r === '24h' ? 'analytics.range24h' : r === '7d' ? 'analytics.range7d' : 'analytics.range30d')}
              </Button>
            ))}
          </div>
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label={t('analytics.requests')} value={summary?.totalRequests ?? 0} hint={requestsHint} />
          <Stat label={t('analytics.successRate')} value={`${summary?.successRate ?? 0}%`} />
          <Stat label={t('analytics.inputTokens')} value={formatTokens(summary?.totalInputTokens)} />
          <Stat label={t('analytics.outputTokens')} value={formatTokens(summary?.totalOutputTokens)} />
          <Stat label={t('analytics.avgLatency')} value={`${summary?.avgLatencyMs ?? 0} ms`} />
          {/* Priced per request at the served model's paid-API equivalent
              rate (not a flat frontier-model rate) — see db/model-pricing.ts.
              The value is a 30-day projection; the hover hint tells the whole
              story (actual period amount + whether it was extrapolated). */}
          <Stat label={t('analytics.estSavings')} value={`$${savings30d.toFixed(2)}`} hint={savingsHint} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title={t('analytics.requestsByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="requests" fill={primaryFill} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title={t('analytics.avgLatencyByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="avgLatencyMs" name={t('analytics.latencyMs')} fill="var(--muted-foreground)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

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
                    <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name={t('common.success')} stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name={t('common.failures')} stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
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
                        <SortableHeader column="model" label={t('common.model')} align="left" extraClass="pl-4" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader column="provider" label={t('common.provider')} align="left" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader column="requests" label={t('analytics.requests')} align="right" sort={sort} onClick={onHeaderClick} />
                        <TableHead className="text-right">{t('analytics.pinned')}</TableHead>
                        <SortableHeader column="success" label={t('common.success')} align="right" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader column="latency" label={t('analytics.latency')} align="right" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader column="inTokens" label={t('analytics.inTokens')} align="right" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader column="outTokens" label={t('analytics.outTokens')} align="right" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader column="saved" label={t('analytics.saved')} align="right" extraClass="pr-4" sort={sort} onClick={onHeaderClick} />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedByModel.map((m: any, i: number) => (
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

          <Panel title={t('analytics.errorsByProvider')}>
            {!errorDist?.byPlatform?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" fill="var(--destructive)" radius={[3, 3, 0, 0]} />
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
                    {errors.slice(0, 20).map((e: any) => (
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
        </div>
      </div>
    </div>
  )
}
