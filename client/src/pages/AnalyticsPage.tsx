import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
  PieChart, Pie, Cell,
} from 'recharts'
import { ArrowUpDown, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
} from '@/components/ui/drawer'

type TimeRange = '1h' | '24h' | '7d' | '30d'

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatAxisLabel(value: string, range: TimeRange): string {
  if (!value) return ''
  if (range === '1h') {
    // 2026-06-05T06:42:00 → 06:42
    return value.slice(11, 16)
  }
  if (range === '24h') {
    // 2026-06-05T06:00:00 → 6 AM
    const hour = parseInt(value.slice(11, 13), 10)
    const ampm = hour >= 12 ? 'PM' : 'AM'
    const h = hour % 12 || 12
    return `${h} ${ampm}`
  }
  // 7d / 30d: 2026-06-05 → Jun 5
  const date = new Date(value + 'T00:00:00')
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function Stat({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className="rounded-3xl border bg-card px-4 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
}

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function statusBadge(status: string, error?: string | null) {
  if (status === 'success') return { label: '200 OK', variant: 'default' as const }
  if (error) {
    if (error.includes('429')) return { label: '429 Rate Limit', variant: 'secondary' as const }
    if (error.includes('401')) return { label: '401 Unauthorized', variant: 'destructive' as const }
    if (error.includes('403')) return { label: '403 Forbidden', variant: 'destructive' as const }
    if (error.includes('404')) return { label: '404 Not Found', variant: 'destructive' as const }
    if (error.includes('500')) return { label: '500 Server Error', variant: 'destructive' as const }
    if (error.includes('502')) return { label: '502 Bad Gateway', variant: 'destructive' as const }
    if (error.includes('503')) return { label: '503 Unavailable', variant: 'destructive' as const }
    if (error.includes('timeout') || error.includes('ETIMEDOUT') || error.includes('ECONNREFUSED')) return { label: 'Timeout / Conn', variant: 'destructive' as const }
  }
  return { label: 'Error', variant: 'destructive' as const }
}

/* ── Wrap long X-axis labels into multiple lines for bar charts ── */
function wrapLabel(text: string, maxLen = 14): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxLen && current.length > 0) {
      lines.push(current.trim())
      current = word
    } else {
      current = (current + ' ' + word).trim()
    }
  }
  if (current) lines.push(current.trim())
  return lines.length ? lines : [text]
}

const WrappedTick = (props: any) => {
  const { x, y, payload } = props
  const lines = wrapLabel(payload.value, 14)
  return (
    <g transform={`translate(${x},${y})`}>
      {lines.map((line, i) => (
        <text
          key={i}
          x={0}
          y={i * 12}
          dy={8}
          textAnchor="middle"
          fill="var(--muted-foreground)"
          fontSize={10}
        >
          {line}
        </text>
      ))}
    </g>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'

/* ── Over Time chart: aggregates per-model rows by timestamp so each
    point on the X axis is the total across all models for that bucket ── */
function OverTimeChart({ data, range }: { data: any[]; range: TimeRange }) {
  const chartData = useMemo(() => {
    const map = new Map<string, { timestamp: string; requests: number; estimatedCost: number }>()
    for (const row of data) {
      const existing = map.get(row.timestamp)
      if (existing) {
        existing.requests += row.requests ?? 0
        existing.estimatedCost += row.estimatedCost ?? 0
      } else {
        map.set(row.timestamp, {
          timestamp: row.timestamp,
          requests: row.requests ?? 0,
          estimatedCost: row.estimatedCost ?? 0,
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }, [data])

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={chartData} margin={{ top: 6, right: 10, left: 10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
        <XAxis
          dataKey="timestamp"
          tick={axisStyle}
          tickFormatter={(v: string) => formatAxisLabel(v, range)}
          tickLine={false}
          axisLine={{ stroke: gridStyle }}
        />
        <YAxis
          yAxisId="left"
          label={{ value: 'Requests', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: 'var(--muted-foreground)' } }}
          tick={axisStyle}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          label={{ value: 'Cost ($)', angle: 90, position: 'insideRight', style: { fontSize: 10, fill: 'var(--muted-foreground)' } }}
          tick={axisStyle}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
          content={({ active, payload, label }) => {
            if (!active || !payload || payload.length === 0) return null
            const p = payload[0].payload as any
            return (
              <div className="rounded-lg border bg-popover p-2 text-popover-foreground shadow-md text-xs space-y-1">
                <p className="font-medium text-muted-foreground">{label}</p>
                <p><span className="text-muted-foreground">Requests:</span> {p.requests}</p>
                <p><span className="text-muted-foreground">Cost:</span> ${p.estimatedCost?.toFixed(2) ?? '0.00'}</p>
              </div>
            )
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
        <Line yAxisId="left" type="monotone" dataKey="requests" name="Requests" stroke={primaryFill} strokeWidth={1.5} dot={false} />
        <Line yAxisId="right" type="monotone" dataKey="estimatedCost" name="Cost ($)" stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<TimeRange>('7d')
  const [modelView, setModelView] = useState<'table' | 'bar' | 'pie'>('table')
  const [modelMode, setModelMode] = useState<'total' | 'overTime'>('total')
  const [showPieLabels, setShowPieLabels] = useState(true)
  const [sortKey, setSortKey] = useState<string>('requests')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

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

  const { data: byModelTimeline = [] } = useQuery({
    queryKey: ['analytics', 'by-model-timeline', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/by-model-timeline?range=${range}`),
    enabled: modelMode === 'overTime',
  })

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/errors?range=${range}`),
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<{ byCategory: any[]; byPlatform: any[]; detailed: any[] }>(`/api/analytics/error-distribution?range=${range}`),
  })

  const [logFilter, setLogFilter] = useState<'all' | 'errors'>('all')
  const [selectedLog, setSelectedLog] = useState<any | null>(null)

  const { data: liveRequests = [] } = useQuery({
    queryKey: ['analytics', 'live-requests', range, logFilter],
    queryFn: () => apiFetch<any[]>(`/api/analytics/live-requests?range=${range}&errorsOnly=${logFilter === 'errors'}`),
  })

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Request volume, latency, token usage, and failures."
        actions={
          <div className="flex gap-1 rounded-lg border p-0.5">
            {(['1h', '24h', '7d', '30d'] as TimeRange[]).map(r => (
              <Button
                key={r}
                variant={range === r ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setRange(r)}
              >
                {r}
              </Button>
            ))}
          </div>
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Requests" value={summary?.totalRequests ?? 0} />
          <Stat label="Success rate" value={`${summary?.successRate ?? 0}%`} />
          <Stat label="Input tokens" value={formatTokens(summary?.totalInputTokens)} />
          <Stat label="Output tokens" value={formatTokens(summary?.totalOutputTokens)} />
          <Stat label="Avg latency" value={`${summary?.avgLatencyMs ?? 0} ms`} />
          <Stat label="Est. savings" value={`$${summary?.estimatedCostSavings ?? '0.00'}`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title="Requests by provider">
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
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

          <Panel title="Avg latency by provider">
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis
                    tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`}
                    tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    formatter={(value: any) => {
                      const num = Number(value)
                      return [num >= 1000 ? `${(num / 1000).toFixed(1)}s` : `${num}ms`, 'Latency']
                    }}
                  />
                  <Bar dataKey="avgLatencyMs" name="Latency" fill="var(--muted-foreground)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Requests over time">
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: 15, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis
                      dataKey="timestamp"
                      tick={axisStyle}
                      tickFormatter={(v: string) => formatAxisLabel(v, range)}
                      tickLine={false}
                      axisLine={{ stroke: gridStyle }}
                    />
                    <YAxis
                      label={{ value: 'Requests', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: 'var(--muted-foreground)' } }}
                      tick={axisStyle}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name="Success" stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name="Failures" stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel
              title="Per-model breakdown"
              action={
                <div className="flex items-center gap-2">
                  <div className="flex gap-1 rounded-lg border p-0.5">
                    {(['total', 'overTime'] as const).map(m => (
                      <Button
                        key={m}
                        variant={modelMode === m ? 'secondary' : 'ghost'}
                        size="xs"
                        onClick={() => {
                          setModelMode(m)
                          if (m === 'overTime' && modelView === 'pie') setModelView('bar')
                        }}
                      >
                        {m === 'total' ? 'Total' : 'Over Time'}
                      </Button>
                    ))}
                  </div>
                  <div className="flex gap-1 rounded-lg border p-0.5">
                    {(['table', 'bar', 'pie'] as const).map(v => (
                      <Button
                        key={v}
                        variant={modelView === v ? 'secondary' : 'ghost'}
                        size="xs"
                        disabled={modelMode === 'overTime' && v === 'pie'}
                        onClick={() => setModelView(v)}
                      >
                        {v === 'table' ? 'Table' : v === 'bar' ? 'Chart' : 'Pie'}
                      </Button>
                    ))}
                  </div>
                  {modelView === 'pie' && (
                    <div className="flex gap-1 rounded-lg border p-0.5">
                      <Button
                        variant={showPieLabels ? 'secondary' : 'ghost'}
                        size="xs"
                        onClick={() => setShowPieLabels(s => !s)}
                      >
                        Labels
                      </Button>
                    </div>
                  )}
                </div>
              }
            >
              {byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
              ) : modelMode === 'total' ? (
                modelView === 'table' ? (
                  <div className="max-h-[360px] overflow-y-auto -mx-4">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">Model</TableHead>
                          <TableHead>Provider</TableHead>
                          {([
                            { key: 'requests', label: 'Requests' },
                            { key: 'successRate', label: 'Success' },
                            { key: 'avgLatencyMs', label: 'Latency' },
                            { key: 'totalInputTokens', label: 'In tokens' },
                            { key: 'totalOutputTokens', label: 'Out tokens' },
                            { key: 'estimatedCost', label: 'Cost' },
                          ] as const).map(col => (
                            <TableHead
                              key={col.key}
                              className={`text-right cursor-pointer select-none ${col.key === 'estimatedCost' ? 'pr-4' : ''}`}
                              onClick={() => {
                                if (sortKey === col.key) {
                                  setSortDir(d => d === 'asc' ? 'desc' : 'asc')
                                } else {
                                  setSortKey(col.key)
                                  setSortDir('desc')
                                }
                              }}
                            >
                              <span className="inline-flex items-center gap-0.5">
                                {col.label}
                                {sortKey === col.key && <ArrowUpDown className="size-3" />}
                              </span>
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...byModel].sort((a: any, b: any) => {
                          const av = a[sortKey] ?? 0
                          const bv = b[sortKey] ?? 0
                          return sortDir === 'asc' ? av - bv : bv - av
                        }).map((m: any, i: number) => (
                          <TableRow key={i}>
                            <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                            <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(m.totalOutputTokens)}</TableCell>
                            <TableCell className="text-right tabular-nums pr-4">${m.estimatedCost?.toFixed(2) ?? '0.00'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : modelView === 'bar' ? (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={byModel} margin={{ top: 6, right: 6, left: -12, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                      <XAxis
                        dataKey="displayName"
                        tick={<WrappedTick />}
                        tickLine={false}
                        axisLine={{ stroke: gridStyle }}
                        interval={0}
                      />
                      <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                      <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                      <Bar dataKey="requests" fill={primaryFill} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <PieChart>
                      <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                      <Pie
                        data={byModel}
                        dataKey="requests"
                        nameKey="displayName"
                        cx="50%"
                        cy="50%"
                        outerRadius={110}
                        labelLine={false}
                        label={showPieLabels ? ({ name, percent }: any) => `${name}: ${(percent * 100).toFixed(0)}%` : false}
                      >
                        {byModel.map((_: any, index: number) => (
                          <Cell key={`cell-${index}`} fill={`hsl(${(index * 137.5) % 360}, 60%, 55%)`} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                )
              ) : (
                /* Over Time mode */
                byModelTimeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
                ) : modelView === 'table' ? (
                  <div className="max-h-[360px] overflow-y-auto -mx-4">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">Time</TableHead>
                          <TableHead>Model</TableHead>
                          <TableHead className="text-right">Requests</TableHead>
                          <TableHead className="text-right">In tokens</TableHead>
                          <TableHead className="text-right">Out tokens</TableHead>
                          <TableHead className="text-right pr-4">Cost</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {byModelTimeline.map((m: any, i: number) => (
                          <TableRow key={i}>
                            <TableCell className="pl-4 text-xs text-muted-foreground tabular-nums">{m.timestamp}</TableCell>
                            <TableCell className="text-xs">{m.modelId}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(m.totalOutputTokens)}</TableCell>
                            <TableCell className="text-right tabular-nums pr-4">${m.estimatedCost?.toFixed(2) ?? '0.00'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <OverTimeChart data={byModelTimeline} range={range} />
                )
              )}
            </Panel>
          </div>

          <Panel title="Errors by provider">
            {!errorDist?.byPlatform?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">No errors</p>
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

          <Panel title="Recent errors">
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No errors</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Provider</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead className="text-right pr-4">Time</TableHead>
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

          <div className="lg:col-span-2">
            <Panel
              title="Live Request Log"
              action={
                <div className="flex gap-1 rounded-lg border p-0.5">
                  {(['all', 'errors'] as const).map(f => (
                    <Button
                      key={f}
                      variant={logFilter === f ? 'secondary' : 'ghost'}
                      size="xs"
                      onClick={() => setLogFilter(f)}
                    >
                      {f === 'all' ? 'All' : 'Errors Only'}
                    </Button>
                  ))}
                </div>
              }
            >
              {liveRequests.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No requests</p>
              ) : (
                <div className="max-h-[420px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Time</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right pr-4">Latency</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {liveRequests.map((req: any) => {
                        const badge = statusBadge(req.status, req.error)
                        return (
                          <TableRow
                            key={req.id}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => setSelectedLog(req)}
                          >
                            <TableCell className="pl-4 text-xs text-muted-foreground tabular-nums">
                              {formatSqliteUtcToLocalTime(req.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </TableCell>
                            <TableCell className="text-xs">{req.platform}</TableCell>
                            <TableCell className="text-xs">{req.displayName ?? req.modelId}</TableCell>
                            <TableCell>
                              <Badge variant={badge.variant}>{badge.label}</Badge>
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums pr-4">
                              {req.latencyMs >= 1000 ? `${(req.latencyMs / 1000).toFixed(1)}s` : `${req.latencyMs}ms`}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>
        </div>
      </div>

      {/* Controlled drawer for row click details */}
      {selectedLog && (
        <Drawer open onOpenChange={() => setSelectedLog(null)}>
          <DrawerContent>
            <DrawerClose onClick={() => setSelectedLog(null)} className="flex items-center justify-center">
              <X className="size-4" />
            </DrawerClose>
            <DrawerTitle>Request Details</DrawerTitle>
            <DrawerDescription>ID {selectedLog.id}</DrawerDescription>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time</span>
                <span className="tabular-nums">
                  {formatSqliteUtcToLocalTime(selectedLog.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Provider</span>
                <span>{selectedLog.platform}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Model</span>
                <span>{selectedLog.displayName ?? selectedLog.modelId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={statusBadge(selectedLog.status, selectedLog.error).variant}>
                  {statusBadge(selectedLog.status, selectedLog.error).label}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Latency</span>
                <span className="tabular-nums">{selectedLog.latencyMs} ms</span>
              </div>
              {selectedLog.error && (
                <div className="space-y-1">
                  <span className="text-muted-foreground">Error</span>
                  <pre className="rounded-lg bg-muted p-2 text-xs whitespace-pre-wrap break-all">{selectedLog.error}</pre>
                </div>
              )}
            </div>
          </DrawerContent>
        </Drawer>
      )}
    </div>
  )
}
