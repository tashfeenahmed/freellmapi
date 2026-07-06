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
  providerLabel,
  type ModelGroupRow,
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
export function RowContent({
  row,
  rank,
  draggable,
  dragHandle,
  onToggle,
}: {
  row: Row
  rank: number
  draggable: boolean
  dragHandle?: ReactNode
  onToggle: (modelDbId: number, enabled: boolean) => void
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
          <span className="text-xs text-muted-foreground">{providerLabel(row)}</span>
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
          {(row.penalty ?? 0) > 0 && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('models.penalty', { value: row.penalty })}</span>
          )}
          {row.totalRequests !== undefined && row.totalRequests > 0 && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">{t('models.obs', { count: row.totalRequests })}</span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground/70 tabular-nums mt-0.5">
          {/* Token budget only when it's a real token count; rate-limited models
              (NVIDIA's "free · 40 RPM") show their rate, not "… tok/mo". */}
          {[
            (row.monthlyTokenBudgetTokens ?? 0) > 0 ? t('models.tokPerMonth', { count: row.monthlyTokenBudget }) : null,
            row.rpmLimit ? t('models.rpmLimit', { count: row.rpmLimit }) : null,
            row.rpdLimit ? t('models.rpdLimit', { count: row.rpdLimit }) : null,
          ].filter(Boolean).join(' · ') || cleanQuotaLabel(row.monthlyTokenBudget) || '—'}
        </div>
      </td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={row.reliability} color="#22c55e" /></td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={row.speed} color="#3b82f6" /></td>
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
export function GroupHeaderCells({ group, rank, dragHandle, onToggleGroup }: {
  group: ModelGroupRow
  rank: number
  dragHandle?: ReactNode
  onToggleGroup: (memberIds: number[], enabled: boolean) => void
}) {
  const { t } = useI18n()
  const anyEnabled = group.members.some(m => m.enabled)
  const solo = group.members.length === 1
  const best = group.members.reduce((b, m) => ((m.score ?? -1) > (b.score ?? -1) ? m : b), group.members[0])
  const guard = (best.headroom ?? 1) * (best.rateLimit ?? 1)
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
              ? <span className="text-xs text-muted-foreground">{providerLabel(group.members[0])}</span>
              : <Tooltip text={t('models.servedBy', { providers: group.members.map(m => providerLabel(m)).join(', ') })}>
                  <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground">{t('models.providerCount', { count: group.members.length })}</span>
                </Tooltip>}
            {quota && (
              <span title={quota.title} className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground tabular-nums">
                {quota.text}
              </span>
            )}
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
      <td className="py-2 pr-3 align-middle"><AxisBar value={best.reliability} color="#22c55e" /></td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={best.speed} color="#3b82f6" /></td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={best.intelligence} color="#a855f7" /></td>
      <td className="py-2 pr-3 align-middle font-mono text-[11px] text-muted-foreground tabular-nums">{guard < 0.999 ? `×${guard.toFixed(2)}` : '—'}</td>
      <td className="py-2 pr-3 align-middle text-right font-mono text-xs font-medium tabular-nums">{best.score !== undefined ? best.score.toFixed(3) : '–'}</td>
      <td className="py-2 pr-3 align-middle text-right" onClick={e => e.stopPropagation()}>
        <Switch checked={anyEnabled} onCheckedChange={(c) => onToggleGroup(group.members.map(m => m.modelDbId), c)} />
      </td>
    </>
  )
}

export function SortableGroupRow({ group, rank, onToggleGroup }: {
  group: ModelGroupRow
  rank: number
  onToggleGroup: (memberIds: number[], enabled: boolean) => void
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
      <GroupHeaderCells group={group} rank={rank} dragHandle={handle} onToggleGroup={onToggleGroup} />
    </tr>
  )
}
