import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useI18n } from '@/i18n'
import { CopyButton } from '@/components/copy-button'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/tooltip'
import {
  cleanQuotaLabel,
  formatContext,
  groupMaxContext,
  groupQuotaBadge,
  memberEndpointTitle,
  memberProviderLabel,
  providerLabel,
  tightestRateLimit,
  type ModelGroupRow,
  type RateLimitUsageRow,
  type Row,
} from '@/lib/routing'

// The unified model/provider table pieces, extracted from FallbackPage so the
// Models page and the per-model detail page share one module.

// A 0..1 value as a thin horizontal bar with the number beside it.
export function AxisBar({ value, color }: { value: number | undefined; color: string }) {
  const v = value ?? 0
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.round(v * 100)}%`, backgroundColor: color }} />
      </div>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums w-7 text-right">
        {value === undefined ? '–' : Math.round(v * 100)}
      </span>
    </div>
  )
}

// The honest replacement for prior-valued bars (#580): a measured axis value
// only exists once a provider has served requests. Before that the bandit uses
// exploration priors (0.5 reliability / 0.6 speed) — rendering those as bars
// reads as a real, suspiciously identical measurement, so unmeasured providers
// get this explicit placeholder instead.
export function AxisNoData() {
  const { t } = useI18n()
  return (
    <Tooltip text={t('models.noDataTitle')}>
      <div className="flex items-center gap-1.5 cursor-help">
        <div className="h-1.5 w-12 rounded-full border border-dashed border-muted-foreground/30" />
        <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap">{t('models.noData')}</span>
      </div>
    </Tooltip>
  )
}

// The min–max of the defined values, or null when none are defined.
function rangeOf(values: (number | undefined)[]): { min: number; max: number } | null {
  const nums = values.filter((v): v is number => v !== undefined)
  if (nums.length === 0) return null
  return { min: Math.min(...nums), max: Math.max(...nums) }
}

// A group's axis as a min–max band across its providers, collapsing to the
// plain single-value bar when the providers agree (or there is only one).
// Groups show the true spread instead of silently promoting the best member's
// number to the whole group (#580).
function AxisRangeBar({ values, color }: { values: (number | undefined)[]; color: string }) {
  const range = rangeOf(values)
  if (range === null) return <AxisBar value={undefined} color={color} />
  const lo = Math.round(range.min * 100)
  const hi = Math.round(range.max * 100)
  if (lo === hi) return <AxisBar value={range.max} color={color} />
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-1.5 w-12 rounded-full bg-muted overflow-hidden">
        <div
          className="absolute inset-y-0 rounded-full"
          style={{ left: `${lo}%`, width: `${Math.max(4, hi - lo)}%`, backgroundColor: color }}
        />
      </div>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums min-w-7 text-right whitespace-nowrap">
        {lo}–{hi}
      </span>
    </div>
  )
}

// The shared table header for the unified model/provider table — used by the
// Models page and the per-model detail page so their columns line up.
export function ModelTableHead() {
  const { t } = useI18n()
  return (
    <thead>
      <tr className="text-left text-muted-foreground border-b">
        <th className="py-2 pl-3 pr-1 w-6"></th>
        <th className="py-2 pr-2 w-6 text-center font-medium">#</th>
        <th className="py-2 pr-3 font-medium">{t('models.columnModel')}</th>
        <th className="py-2 pr-3 font-medium">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: '#22c55e' }} />{t('strategies.weightReliability')}</span>
        </th>
        <th className="py-2 pr-3 font-medium">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: '#3b82f6' }} />{t('strategies.weightSpeed')}</span>
        </th>
        <th className="py-2 pr-3 font-medium">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: '#a855f7' }} />{t('strategies.weightIntelligence')}</span>
        </th>
        <th className="py-2 pr-3 font-medium">
          <Tooltip text={t('strategies.guardrailsTooltip')}>
            <span className="underline decoration-dotted underline-offset-2 cursor-help">{t('strategies.guardrails')}</span>
          </Tooltip>
        </th>
        <th className="py-2 pr-3 font-medium text-right">
          <Tooltip text={t('strategies.scoreTooltip')}>
            <span className="underline decoration-dotted underline-offset-2 cursor-help">{t('strategies.scoreColumn')}</span>
          </Tooltip>
        </th>
        <th className="py-2 pr-3 font-medium text-right">{t('models.columnOn')}</th>
      </tr>
    </thead>
  )
}

// ── One row of the unified table ────────────────────────────────────────────
// Time-window rate-limit pressure for one logical model or one provider row
// (#876). Shared by the Models table group header, the model detail page's
// summary badges and its per-provider rows so all three read identically.
// Renders nothing when there is no usage to report.
export function RateLimitBadge({ rows, size = 'sm' }: { rows: RateLimitUsageRow[]; size?: 'sm' | 'md' }) {
  const { t } = useI18n()
  const tightest = tightestRateLimit(rows)
  if (!tightest) return null
  const ratio = tightest.limit > 0 ? tightest.used / tightest.limit : 0
  const tone = tightest.used >= tightest.limit
    ? 'bg-red-600/15 text-red-700 dark:text-red-400'
    : ratio >= 0.7
      ? 'bg-amber-600/15 text-amber-700 dark:text-amber-400'
      : 'bg-muted text-muted-foreground'
  const scale = size === 'md' ? 'text-[11px] px-2 py-0.5' : 'text-[10px] px-1.5 py-0.5'
  return (
    <span title={t('models.rateLimitUsageTitle')} className={`rounded-full tabular-nums ${scale} ${tone}`}>
      {t('models.rateLimitUsage', { kind: tightest.kind, used: tightest.used, limit: tightest.limit })}
    </span>
  )
}

export function RowContent({
  row,
  rank,
  draggable,
  dragHandle,
  onToggle,
  providerName,
  providerTitle,
  rateUsage,
}: {
  row: Row
  rank: number
  draggable: boolean
  dragHandle?: ReactNode
  onToggle: (modelDbId: number, enabled: boolean) => void
  // Overrides the provider label — the model page passes an endpoint-qualified
  // one when two custom endpoints serve this same model id (#651).
  providerName?: string
  // Hover text for that label, supplied ONLY when the caller actually had to
  // disambiguate. Never derived from row.endpointScope here: every custom row
  // carries a scope, so doing so would leak the base URL of a lone endpoint.
  providerTitle?: string
  // This provider's own time-window usage (#876), when the caller fetched it.
  rateUsage?: RateLimitUsageRow
}) {
  const { t } = useI18n()
  const guard = (row.headroom ?? 1) * (row.rateLimit ?? 1)
  return (
    <>
      <td className="py-2 pl-3 pr-1 w-6 align-middle">
        {draggable ? dragHandle : <span className="text-muted-foreground/30 select-none">·</span>}
      </td>
      <td className="py-2 pr-2 w-6 text-center font-mono text-xs text-muted-foreground tabular-nums align-middle">{rank}</td>
      <td className="py-2 pr-3 align-middle">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{row.displayName}</span>
          <span className="text-xs text-muted-foreground" title={providerTitle}>
            {providerName ?? providerLabel(row)}
          </span>
          <RateLimitBadge rows={rateUsage ? [rateUsage] : []} />
          {row.supportsVision && (
            <span
              title={t('models.visionTitle')}
              className="text-[10px] rounded-full px-1.5 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400"
            >
              {t('models.vision')}
            </span>
          )}
          {row.supportsTools && (
            <span
              title={t('models.toolsTitle')}
              className="text-[10px] rounded-full px-1.5 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400"
            >
              {t('models.tools')}
            </span>
          )}
          {row.retiredUpstream && (
            <span
              title={row.retiredReason ?? undefined}
              className="text-[10px] rounded-full px-1.5 py-0.5 bg-rose-600/15 text-rose-700 dark:bg-rose-400/15 dark:text-rose-400"
            >
              {t('models.retired')}
            </span>
          )}
          {(row.penalty ?? 0) > 0 && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('models.penalty', { value: row.penalty })}</span>
          )}
          {row.totalRequests !== undefined && row.totalRequests > 0 && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">{t('models.obs', { count: row.totalRequests })}</span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground/70 tabular-nums mt-0.5">
          {/* Token budget only when it's a real token count; rate-limited models
              (NVIDIA's "free · 40 RPM") show their rate, not "… tok/mo".

              The catalog figure is PER KEY. The router credits it once per key
              it can rotate through, so an operator with three keys really does
              have three times the budget — and reading the bare catalog string
              back made it look like adding keys changed nothing (#688). The
              multiplier is written as "× N" rather than a sentence so it needs
              no translation, and the catalog's own wording ("~10-20M") is kept
              instead of a computed total, which would state a range's high end
              as if it were fact. */}
          {[
            (row.monthlyTokenBudgetTokens ?? 0) > 0
              ? t('models.tokPerMonth', { count: row.monthlyTokenBudget }) + (row.keyCount > 1 ? ` × ${row.keyCount}` : '')
              : null,
            row.rpmLimit ? t('models.rpmLimit', { count: row.rpmLimit }) : null,
            row.rpdLimit ? t('models.rpdLimit', { count: row.rpdLimit }) : null,
          ].filter(Boolean).join(' · ') || cleanQuotaLabel(row.monthlyTokenBudget) || '—'}
        </div>
      </td>
      {/* Reliability/speed are measured axes: with zero recorded requests the
          scorer only has its exploration priors, so show an explicit "no data"
          state instead of prior-valued bars (#580). Intelligence is catalog
          metadata and stays. */}
      <td className="py-2 pr-3 align-middle">{row.totalRequests === 0 ? <AxisNoData /> : <AxisBar value={row.reliability} color="#22c55e" />}</td>
      <td className="py-2 pr-3 align-middle">{row.totalRequests === 0 ? <AxisNoData /> : <AxisBar value={row.speed} color="#3b82f6" />}</td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={row.intelligence} color="#a855f7" /></td>
      <td className="py-2 pr-3 align-middle font-mono text-[11px] text-muted-foreground tabular-nums">
        {guard < 0.999 ? `×${guard.toFixed(2)}` : '—'}
      </td>
      <td className="py-2 pr-3 align-middle text-right font-mono text-xs font-medium tabular-nums">
        {row.score !== undefined ? row.score.toFixed(3) : '–'}
      </td>
      <td className="py-2 pr-3 align-middle text-right">
        <Switch checked={row.enabled} onCheckedChange={(c) => onToggle(row.modelDbId, c)} />
      </td>
    </>
  )
}

// Shared drag-handle glyph (also used by the Embeddings provider list, so the
// two reorder surfaces look identical).
export const dragDots = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
    <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
    <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
  </svg>
)

// The collapsed header row for a logical-model group: name, provider count,
// union vision/tools badges, the best member's axis bars + score, and a single
// switch that enables/disables every provider in the group.
export function GroupHeaderCells({ group, rank, dragHandle, onToggleGroup, allRows, rateUsage }: {
  group: ModelGroupRow
  rank: number
  dragHandle?: ReactNode
  onToggleGroup: (memberIds: number[], enabled: boolean) => void
  // Every configured row, for endpoint disambiguation. Two relays serving one
  // model id land in different display groups the moment one copy is renamed,
  // so the group's own members are not a complete sibling set (#651).
  allRows?: readonly Row[]
  // Time-window rate-limit usage by model db id (#876). Fetched ONCE at the page
  // level and passed down: a query hook here would open one observer and one
  // 15s poll timer per row, i.e. hundreds of them on a real catalog.
  rateUsage?: ReadonlyMap<number, RateLimitUsageRow>
}) {
  const { t } = useI18n()
  const anyEnabled = group.members.some(m => m.enabled)
  const solo = group.members.length === 1
  const best = group.members.reduce((b, m) => ((m.score ?? -1) > (b.score ?? -1) ? m : b), group.members[0])
  const guard = (best.headroom ?? 1) * (best.rateLimit ?? 1)
  // Remaining time-window quota for this group (#876): the member with the most
  // headroom decides the badge, since the group stays routable while any one of
  // its providers can serve. Lookup is O(members) against the shared map.
  const rateRows = rateUsage
    ? group.members.flatMap(m => rateUsage.get(m.modelDbId) ?? [])
    : []
  // Honest group display (#580): reliability/speed ranges come only from
  // members that were actually measured; when none were, show "no data" rather
  // than the shared exploration priors. Intelligence is catalog metadata, so
  // its range spans every member. The score cell keeps the best member's score
  // (that is what routing would pick) but labels it "best of N" with the
  // per-provider breakdown in a tooltip.
  const siblings = allRows ?? group.members
  const measured = group.members.filter(m => (m.totalRequests ?? 0) > 0)
  const scoreBreakdown = group.members
    .map(m => `${memberProviderLabel(m, siblings)} ${m.score !== undefined ? m.score.toFixed(3) : '–'}`)
    .join('\n')
  const vision = group.members.some(m => m.supportsVision)
  const tools = group.members.some(m => m.supportsTools)
  const quota = groupQuotaBadge(group.members, t)
  const maxCtx = groupMaxContext(group.members)
  // The model name links to its own page, which lists every provider that serves
  // it (replaces the old inline expansion).
  const detailId = encodeURIComponent(group.members[0].canonicalId ?? group.members[0].modelId)
  // The unified model string to paste into .env / API payloads (#343 quick-copy).
  const copyId = group.members[0].canonicalId ?? group.members[0].modelId
  return (
    <>
      <td className="py-2 pl-3 pr-1 w-6 align-middle">{dragHandle ?? <span className="text-muted-foreground/30 select-none">·</span>}</td>
      <td className="py-2 pr-2 w-6 text-center font-mono text-xs text-muted-foreground tabular-nums align-middle">{rank}</td>
      <td className="py-2 pr-3 align-middle">
        <div className="flex items-center gap-1.5 min-w-0">
          <Link to={`/models/chat/${detailId}`} aria-label={t('models.viewProviders')} onClick={e => e.stopPropagation()} className="flex items-center gap-2 flex-wrap text-left min-w-0">
            <span className="font-medium text-sm">{group.label}</span>
            {solo
              ? <span className="text-xs text-muted-foreground" title={memberEndpointTitle(group.members[0], siblings)}>{memberProviderLabel(group.members[0], siblings)}</span>
              : <Tooltip text={t('models.servedBy', { providers: group.members.map(m => memberProviderLabel(m, siblings)).join('\n') })}>
                  <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground">{t('models.providerCount', { count: group.members.length })}</span>
                </Tooltip>}
            {quota && (
              <span title={quota.title} className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground tabular-nums">
                {quota.text}
              </span>
            )}
            <RateLimitBadge rows={rateRows} />
            {maxCtx > 0 && (
              <span title={t('models.ctxTitle')} className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground tabular-nums">
                {t('models.ctxBadge', { size: formatContext(maxCtx) })}
              </span>
            )}
            {vision && (
              <span title={t('models.visionTitle')} className="text-[10px] rounded-full px-1.5 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">{t('models.vision')}</span>
            )}
            {tools && (
              <span title={t('models.toolsTitle')} className="text-[10px] rounded-full px-1.5 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">{t('models.tools')}</span>
            )}
          </Link>
          {/* Quick-copy the unified model id (#343). Stop propagation so it neither
              follows the model link nor triggers the row's navigate-on-click. */}
          <span onClick={e => e.stopPropagation()} className="shrink-0">
            <CopyButton
              text={copyId}
              label={t('models.copyModelId')}
              className="size-6 border-0 bg-transparent hover:bg-muted opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            />
          </span>
        </div>
      </td>
      <td className="py-2 pr-3 align-middle">{measured.length === 0 ? <AxisNoData /> : <AxisRangeBar values={measured.map(m => m.reliability)} color="#22c55e" />}</td>
      <td className="py-2 pr-3 align-middle">{measured.length === 0 ? <AxisNoData /> : <AxisRangeBar values={measured.map(m => m.speed)} color="#3b82f6" />}</td>
      <td className="py-2 pr-3 align-middle"><AxisRangeBar values={group.members.map(m => m.intelligence)} color="#a855f7" /></td>
      <td className="py-2 pr-3 align-middle font-mono text-[11px] text-muted-foreground tabular-nums">{guard < 0.999 ? `×${guard.toFixed(2)}` : '—'}</td>
      <td className="py-2 pr-3 align-middle text-right font-mono text-xs font-medium tabular-nums">
        {solo ? (
          best.score !== undefined ? best.score.toFixed(3) : '–'
        ) : (
          <Tooltip text={t('models.perProviderScores', { list: scoreBreakdown })}>
            <span className="inline-flex flex-col items-end cursor-help">
              <span>{best.score !== undefined ? best.score.toFixed(3) : '–'}</span>
              <span className="text-[10px] font-normal text-muted-foreground/60 whitespace-nowrap">{t('models.bestOfN', { count: group.members.length })}</span>
            </span>
          </Tooltip>
        )}
      </td>
      <td className="py-2 pr-3 align-middle text-right" onClick={e => e.stopPropagation()}>
        <Switch checked={anyEnabled} onCheckedChange={(c) => onToggleGroup(group.members.map(m => m.modelDbId), c)} />
      </td>
    </>
  )
}

export function SortableGroupRow({ group, rank, onToggleGroup, allRows, rateUsage }: {
  group: ModelGroupRow
  rank: number
  onToggleGroup: (memberIds: number[], enabled: boolean) => void
  allRows?: readonly Row[]
  rateUsage?: ReadonlyMap<number, RateLimitUsageRow>
}) {
  const { t } = useI18n()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `grp:${group.key}` })
  const anyEnabled = group.members.some(m => m.enabled)
  const navigate = useNavigate()
  const detailId = encodeURIComponent(group.members[0].canonicalId ?? group.members[0].modelId)
  const handle = (
    <button
      {...attributes}
      {...listeners}
      onClick={e => e.stopPropagation()}
      className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
      aria-label={t('models.dragToReorderGroup')}
    >
      {dragDots}
    </button>
  )
  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => navigate(`/models/chat/${detailId}`)}
      className={`group/row border-b last:border-0 bg-card cursor-pointer transition-colors hover:[&>td]:bg-muted/50 [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg ${isDragging ? 'opacity-50' : ''} ${anyEnabled ? '' : 'opacity-50'}`}
    >
      <GroupHeaderCells group={group} rank={rank} dragHandle={handle} onToggleGroup={onToggleGroup} allRows={allRows} rateUsage={rateUsage} />
    </tr>
  )
}
