import { Fragment, useEffect, useState, useRef, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { Tooltip } from '@/components/tooltip'

interface FallbackEntry {
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
  supportsVision: boolean
  supportsTools: boolean
  keyCount: number
  // Logical-model grouping (sent by the server when unify is relevant). Absent
  // for ungrouped rows; the UI falls back to a per-row "solo" group then.
  groupKey?: string
  canonicalId?: string
  groupLabel?: string
}

type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom'

type RoutingWeights = { reliability: number; speed: number; intelligence: number }

interface RoutingScore {
  modelDbId: number
  reliability: number
  speed: number
  intelligence: number
  headroom: number
  rateLimit: number
  score: number
  totalRequests: number
}

interface RoutingData {
  strategy: RoutingStrategy
  weights: RoutingWeights | null
  customWeights: RoutingWeights
  scores: (RoutingScore & { platform: string; modelId: string; displayName: string; enabled: boolean })[]
}

// A merged row: fallback-chain metadata + live bandit scores.
type Row = FallbackEntry & Partial<RoutingScore>

// `tKey` is the i18n suffix under `strategies.*` (label) and `strategies.*Blurb`.
// It differs from the routing `key` for Manual, whose strategy id is 'priority'.
const STRATEGIES: { key: RoutingStrategy; tKey: string }[] = [
  { key: 'priority', tKey: 'manual' },
  { key: 'balanced', tKey: 'balanced' },
  { key: 'smartest', tKey: 'smartest' },
  { key: 'fastest', tKey: 'fastest' },
  { key: 'reliable', tKey: 'reliable' },
  { key: 'custom', tKey: 'custom' },
]

// Slider axes share the colors used by the score table columns below.
// `tKey` is the i18n suffix under `strategies.weight*`.
const WEIGHT_AXES: { key: keyof RoutingWeights; tKey: string; color: string }[] = [
  { key: 'reliability', tKey: 'weightReliability', color: '#22c55e' },
  { key: 'speed', tKey: 'weightSpeed', color: '#3b82f6' },
  { key: 'intelligence', tKey: 'weightIntelligence', color: '#a855f7' },
]

// Slider popover for the 'custom' strategy. Sliders are independent (0-100)
// and the server renormalizes any vector, so we just show each axis's
// effective share live. Nothing is saved until Apply is pressed.
function CustomWeightsPopover({ saved, onSave, saving }: {
  saved: RoutingWeights
  onSave: (w: RoutingWeights) => void
  saving: boolean
}) {
  const { t } = useI18n()
  const [values, setValues] = useState<RoutingWeights>(() => fromSaved(saved))
  const [dirty, setDirty] = useState(false)

  // Defensive: an older/partial server response (or a future field rename) could
  // leave `saved` undefined; never let that white-screen the whole page (there's
  // no error boundary above us). Fall back to an even split.
  function fromSaved(w?: RoutingWeights): RoutingWeights {
    const safe = w ?? { reliability: 1 / 3, speed: 1 / 3, intelligence: 1 / 3 }
    return {
      reliability: Math.round(safe.reliability * 100),
      speed: Math.round(safe.speed * 100),
      intelligence: Math.round(safe.intelligence * 100),
    }
  }

  function update(key: keyof RoutingWeights, v: number) {
    setValues({ ...values, [key]: v })
    setDirty(true)
  }

  function apply() {
    if (sum <= 0) return
    onSave({
      reliability: values.reliability / 100,
      speed: values.speed / 100,
      intelligence: values.intelligence / 100,
    })
    setDirty(false)
  }

  const sum = values.reliability + values.speed + values.intelligence

  return (
    <Popover onOpenChange={open => { if (open) { setValues(fromSaved(saved)); setDirty(false) } }}>
      <PopoverTrigger className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
        <SlidersHorizontal className="size-3.5" />
        {t('strategies.adjust')}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t('strategies.customWeights')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('strategies.customWeightsHelp')}
            </p>
          </div>
          {WEIGHT_AXES.map(axis => {
            const share = sum > 0 ? Math.round((values[axis.key] / sum) * 100) : 0
            const axisLabel = t(`strategies.${axis.tKey}`)
            return (
              <div key={axis.key}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: axis.color }} />
                    {axisLabel}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{share}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={values[axis.key]}
                  onChange={e => update(axis.key, Number(e.target.value))}
                  className="w-full cursor-pointer"
                  style={{ accentColor: axis.color }}
                  aria-label={`${axisLabel} weight`}
                />
              </div>
            )
          })}
          {sum <= 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t('strategies.weightRequired')}
            </p>
          )}
          <Button
            size="sm"
            className="w-full"
            disabled={!dirty || sum <= 0 || saving}
            onClick={apply}
          >
            {saving ? t('common.applying') : dirty ? t('common.apply') : t('common.applied')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// For models with no monthly token budget, surface their rate quota instead.
// Strips the catalog's decorative bits ("free · ", " per IP", "~", "?") so e.g.
// "free · 40 RPM" → "40 RPM", "free · 200/hr per IP" → "200/hr", "~? (anon)" →
// "anon". Returns null when nothing meaningful remains.
function cleanQuotaLabel(s: string | undefined): string | null {
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

interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: { displayName: string; platform: string; budget: number }[]
}

const platformColors: Record<string, string> = {
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
}

// A 0..1 value as a thin horizontal bar with the number beside it.
function AxisBar({ value, color }: { value: number | undefined; color: string }) {
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

// Legend rows visible while collapsed (~6 rows: 6 × 16px line + 5 × 6px gap).
const LEGEND_COLLAPSED_PX = 126

function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { t } = useI18n()
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0

  // Collapse the per-model legend to a few rows; the chevron reveals the rest.
  // The toggle only appears when the legend actually overflows the collapsed
  // height (column count — and so row count — depends on viewport width).
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const legendRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = legendRef.current
    if (!el) return
    const check = () => setCollapsible(el.scrollHeight > LEGEND_COLLAPSED_PX + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [models.length])

  const modelsWithWidth = models.map(m => ({
    ...m,
    remainingTokens: totalBudget > 0 ? (m.budget / totalBudget) * remaining : 0,
    widthPct: totalBudget > 0 ? (m.budget / totalBudget) * (remaining / totalBudget) * 100 : 0,
  }))
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-medium">{t('models.monthlyTokenBudget')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">{formatTokens(remaining)}</span> {t('models.remaining')}
          <span className="mx-1.5">·</span>
          {remainingPct}% {t('models.of')} {formatTokens(totalBudget)}
        </span>
      </div>

      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {modelsWithWidth.map((m, i) => (
          <div
            key={i}
            title={`${m.displayName} (${m.platform}): ${formatTokens(m.remainingTokens)} remaining`}
            style={{
              width: `${m.widthPct}%`,
              backgroundColor: platformColors[m.platform] ?? '#94a3b8',
            }}
          />
        ))}
        {totalUsed > 0 && (
          <div
            title={`Used: ${formatTokens(totalUsed)}`}
            className="bg-muted-foreground/30"
            style={{ width: `${usedPct}%` }}
          />
        )}
      </div>

      <div
        ref={legendRef}
        className="mt-4 overflow-hidden transition-[max-height] duration-300 ease-in-out"
        style={collapsible ? { maxHeight: expanded ? legendRef.current?.scrollHeight : LEGEND_COLLAPSED_PX } : undefined}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
          {modelsWithWidth.map((m, i) => (
            <div key={i} className="flex items-center gap-2 min-w-0">
              <span
                className="size-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
              />
              <span className="truncate">{m.displayName}</span>
              <span className="flex-1" />
              <span className="font-mono text-muted-foreground">{formatTokens(m.remainingTokens)}</span>
            </div>
          ))}
        </div>
      </div>

      {collapsible && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-2 flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? t('models.showLess') : t('models.showAllModels', { count: models.length })}
          <ChevronDown className={`size-3.5 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </section>
  )
}

// ── One row of the unified table ────────────────────────────────────────────
function RowContent({
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
          <span className="text-xs text-muted-foreground">{row.platform}</span>
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

function SortableRow({ row, rank, onToggle }: { row: Row; rank: number; onToggle: (id: number, e: boolean) => void }) {
  const { t } = useI18n()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.modelDbId })
  const handle = (
    <button
      {...attributes}
      {...listeners}
      className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
      aria-label={t('models.dragToReorder')}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
        <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
        <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
      </svg>
    </button>
  )
  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`border-b last:border-0 bg-card ${isDragging ? 'opacity-50' : ''} ${row.enabled ? '' : 'opacity-50'}`}
    >
      <RowContent row={row} rank={rank} draggable dragHandle={handle} onToggle={onToggle} />
    </tr>
  )
}

// ── Grouped (unified) rendering ──────────────────────────────────────────────
// One logical model and the provider rows that serve it.
interface ModelGroupRow {
  key: string
  label: string
  members: Row[]
}

// Group merged rows by their server-assigned groupKey (or a per-row "solo" key
// when ungrouped). Members are ordered like the flat chain — by manual priority
// under the priority strategy, by live score otherwise — and groups inherit the
// best member's position so the unified order matches the flat order.
function buildGroups(rows: Row[], isManual: boolean): ModelGroupRow[] {
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

const dragDots = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
    <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
    <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
  </svg>
)

// The collapsed header row for a logical-model group: name, provider count,
// union vision/tools badges, the best member's axis bars + score, and a single
// switch that enables/disables every provider in the group.
function GroupHeaderCells({ group, rank, expanded, onToggleExpand, dragHandle, onToggleGroup }: {
  group: ModelGroupRow
  rank: number
  expanded: boolean
  onToggleExpand: () => void
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
  // Quota badge beside the name: the aggregated monthly token budget when the
  // group has one (summed across providers — you can spend all of them via
  // failover), otherwise the model's rate cap (RPM/RPD, or the catalog's rate
  // label) for rate-limited providers like NVIDIA.
  const totalBudget = group.members.reduce((sum, m) => sum + (m.monthlyTokenBudgetTokens ?? 0), 0)
  const maxRpm = Math.max(0, ...group.members.map(m => m.rpmLimit ?? 0))
  const maxRpd = Math.max(0, ...group.members.map(m => m.rpdLimit ?? 0))
  const rateLabelText = group.members.map(m => cleanQuotaLabel(m.monthlyTokenBudget)).find(Boolean) ?? null
  // A summed monthly token budget if the group has one, else a rate cap (RPM/RPD,
  // or the catalog's rate label) for rate-limited providers like NVIDIA.
  function quotaBadge(): { text: string; title: string } | null {
    if (totalBudget > 0) return { text: t('models.aggregateBudget', { count: formatTokens(totalBudget) }), title: t('models.aggregateBudgetTitle') }
    if (maxRpm > 0) return { text: t('models.rateRpm', { count: maxRpm }), title: t('models.rateTitle') }
    if (maxRpd > 0) return { text: t('models.rateRpd', { count: maxRpd }), title: t('models.rateTitle') }
    if (rateLabelText) return { text: rateLabelText, title: t('models.rateTitle') }
    return null
  }
  const quota = quotaBadge()
  return (
    <>
      <td className="py-2 pl-3 pr-1 w-6 align-middle">{dragHandle ?? <span className="text-muted-foreground/30 select-none">·</span>}</td>
      <td className="py-2 pr-2 w-6 text-center font-mono text-xs text-muted-foreground tabular-nums align-middle">{rank}</td>
      <td className="py-2 pr-3 align-middle">
        <button type="button" onClick={onToggleExpand} className="flex items-center gap-2 flex-wrap text-left" aria-expanded={expanded}>
          <ChevronDown className={`size-4 flex-shrink-0 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`} />
          <span className="font-medium text-sm">{group.label}</span>
          {solo
            ? <span className="text-xs text-muted-foreground">{group.members[0].platform}</span>
            : <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground">{t('models.providerCount', { count: group.members.length })}</span>}
          {quota && (
            <span title={quota.title} className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground tabular-nums">
              {quota.text}
            </span>
          )}
          {vision && (
            <span title={t('models.visionTitle')} className="text-[10px] rounded-full px-1.5 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">{t('models.vision')}</span>
          )}
          {tools && (
            <span title={t('models.toolsTitle')} className="text-[10px] rounded-full px-1.5 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">{t('models.tools')}</span>
          )}
        </button>
      </td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={best.reliability} color="#22c55e" /></td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={best.speed} color="#3b82f6" /></td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={best.intelligence} color="#a855f7" /></td>
      <td className="py-2 pr-3 align-middle font-mono text-[11px] text-muted-foreground tabular-nums">{guard < 0.999 ? `×${guard.toFixed(2)}` : '—'}</td>
      <td className="py-2 pr-3 align-middle text-right font-mono text-xs font-medium tabular-nums">{best.score !== undefined ? best.score.toFixed(3) : '–'}</td>
      <td className="py-2 pr-3 align-middle text-right">
        <Switch checked={anyEnabled} onCheckedChange={(c) => onToggleGroup(group.members.map(m => m.modelDbId), c)} />
      </td>
    </>
  )
}

function SortableGroupRow({ group, rank, expanded, onToggleExpand, onToggleGroup }: {
  group: ModelGroupRow
  rank: number
  expanded: boolean
  onToggleExpand: () => void
  onToggleGroup: (memberIds: number[], enabled: boolean) => void
}) {
  const { t } = useI18n()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `grp:${group.key}` })
  const anyEnabled = group.members.some(m => m.enabled)
  const handle = (
    <button
      {...attributes}
      {...listeners}
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
      className={`border-b last:border-0 bg-card ${isDragging ? 'opacity-50' : ''} ${anyEnabled ? '' : 'opacity-50'}`}
    >
      <GroupHeaderCells group={group} rank={rank} expanded={expanded} onToggleExpand={onToggleExpand} dragHandle={handle} onToggleGroup={onToggleGroup} />
    </tr>
  )
}

export default function FallbackPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
  })

  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
    refetchInterval: 15_000,
  })

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setLocalEntries(null)
    },
  })

  const strategyMutation = useMutation({
    mutationFn: (payload: { strategy: RoutingStrategy; weights?: RoutingWeights }) =>
      apiFetch('/api/fallback/routing', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] }),
  })

  const strategy: RoutingStrategy = routing?.strategy ?? 'balanced'
  const isManual = strategy === 'priority'

  // Merge fallback metadata with live scores, keyed by model.
  const scoreById = new Map((routing?.scores ?? []).map(s => [s.modelDbId, s]))
  const allEntries = localEntries ?? entries
  const configured = allEntries.filter(e => e.keyCount > 0)
  const unconfiguredPlatforms = [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))]

  // Entry fields win on overlap: the routing snapshot also carries `enabled`
  // (and identity fields), which would otherwise clobber unsaved local toggles.
  const rows: Row[] = configured.map(e => ({ ...(scoreById.get(e.modelDbId) ?? {}), ...e }))
  // Manual → the order you set (by priority). Bandit → ranked by live score.
  const ordered = isManual
    ? [...rows].sort((a, b) => a.priority - b.priority)
    : [...rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = ordered.findIndex(e => e.modelDbId === active.id)
    const newIndex = ordered.findIndex(e => e.modelDbId === over.id)
    const reorderedVisible = arrayMove(ordered, oldIndex, newIndex)
    const unconfigured = allEntries.filter(e => e.keyCount === 0)
    const merged: FallbackEntry[] = [
      ...reorderedVisible.map((e, i) => ({ ...(e as FallbackEntry), priority: i + 1 })),
      ...unconfigured.map((e, i) => ({ ...e, priority: reorderedVisible.length + i + 1 })),
    ]
    setLocalEntries(merged)
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    setLocalEntries(allEntries.map(e => (e.modelDbId === modelDbId ? { ...e, enabled } : e)))
  }

  function handleSave() {
    saveMutation.mutate(allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled })))
  }

  const hasChanges = localEntries !== null

  // ── Model unification (group the same model across providers) ──────────────
  const { data: unify } = useQuery<{ enabled: boolean }>({
    queryKey: ['unify'],
    queryFn: () => apiFetch('/api/settings/unify'),
  })
  const unifyOn = unify?.enabled ?? true
  const unifyMutation = useMutation({
    mutationFn: (enabled: boolean) => apiFetch('/api/settings/unify', { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unify'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const orderedGroups = buildGroups(rows, isManual)

  function toggleExpand(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleGroupToggle(memberIds: number[], enabled: boolean) {
    const ids = new Set(memberIds)
    setLocalEntries(allEntries.map(e => (ids.has(e.modelDbId) ? { ...e, enabled } : e)))
  }

  // Serialize the displayed group order (group-major, member-minor) to the flat
  // priority list PUT /api/fallback expects; keyless rows keep their tail spot.
  function persistGroupOrder(groups: ModelGroupRow[]) {
    const order: number[] = []
    for (const g of groups) for (const m of g.members) order.push(m.modelDbId)
    const unconfigured = allEntries.filter(e => e.keyCount === 0).map(e => e.modelDbId)
    const prio = new Map([...order, ...unconfigured].map((id, i) => [id, i + 1]))
    setLocalEntries(allEntries.map(e => ({ ...e, priority: prio.get(e.modelDbId) ?? e.priority })))
  }

  function handleGroupedDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const a = String(active.id)
    const o = String(over.id)
    if (a.startsWith('grp:')) {
      if (!o.startsWith('grp:')) return // a group dropped on a member row — ignore
      const oldI = orderedGroups.findIndex(g => `grp:${g.key}` === a)
      const newI = orderedGroups.findIndex(g => `grp:${g.key}` === o)
      if (oldI < 0 || newI < 0) return
      persistGroupOrder(arrayMove(orderedGroups, oldI, newI))
    } else {
      // Member reorder, constrained to within its own group.
      const activeId = Number(a)
      const overId = Number(o)
      const gi = orderedGroups.findIndex(g => g.members.some(m => m.modelDbId === activeId))
      if (gi < 0) return
      const members = orderedGroups[gi].members
      const oldI = members.findIndex(m => m.modelDbId === activeId)
      const newI = members.findIndex(m => m.modelDbId === overId)
      if (newI < 0) return // dropped outside its group — ignore
      const next = orderedGroups.map((g, i) => (i === gi ? { ...g, members: arrayMove(g.members, oldI, newI) } : g))
      persistGroupOrder(next)
    }
  }

  const tableHead = (
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

  return (
    <div>
      <PageHeader
        title={t('models.title')}
        description={t('strategies.description')}
        divider={false}
        actions={<ModelsTabs />}
      />

      <div className="space-y-6">
        {/* Monthly token budget — moved to the top */}
        {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} />}

        {/* Strategy selector */}
        <section className="rounded-3xl border bg-card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium">{t('strategies.title')}</h2>
            {routing?.weights && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('strategies.weightsSummary', {
                  reliability: Math.round(routing.weights.reliability * 100),
                  speed: Math.round(routing.weights.speed * 100),
                  intelligence: Math.round(routing.weights.intelligence * 100),
                })}
              </span>
            )}
          </div>

          <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border p-1">
            {STRATEGIES.map(s => (
              <Tooltip key={s.key} text={t(`strategies.${s.tKey}Blurb`)}>
                <button
                  disabled={strategyMutation.isPending}
                  onClick={() => strategyMutation.mutate({ strategy: s.key })}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                    s.key === strategy
                      ? 'bg-foreground text-background font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  {t(`strategies.${s.tKey}`)}
                </button>
              </Tooltip>
            ))}
            {strategy === 'custom' && routing && (
              <CustomWeightsPopover
                saved={routing.customWeights}
                saving={strategyMutation.isPending}
                onSave={w => strategyMutation.mutate({ strategy: 'custom', weights: w })}
              />
            )}
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            {isManual ? t('strategies.modeManualHint') : t('strategies.modeScoreHint')}
          </p>
        </section>

        {/* Unify duplicate models — collapse the same model served by several
            providers into one expandable row (and one /v1/models entry). */}
        <section className="flex items-center justify-between rounded-3xl border bg-card p-5">
          <div className="min-w-0 pr-4">
            <h2 className="text-sm font-medium">{t('models.unifyToggle')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('models.unifyToggleHint')}</p>
          </div>
          <Switch checked={unifyOn} onCheckedChange={(c) => unifyMutation.mutate(c)} disabled={unifyMutation.isPending} />
        </section>

        {/* Unified routing / fallback table */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : ordered.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {t('models.noModelsBefore')}<a href="/keys" className="underline text-foreground">{t('models.keysPageLink')}</a>{t('models.noModelsAfter')}
            </p>
          </div>
        ) : (
          <>
            {/* DndContext must wrap OUTSIDE the table: it renders hidden a11y
                live-region <div>s, which are invalid as direct <table> children. */}
            {unifyOn ? (
              isManual ? (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupedDragEnd}>
                  <div className="rounded-2xl border overflow-x-auto">
                    <table className="w-full text-sm">
                      {tableHead}
                      <SortableContext items={orderedGroups.map(g => `grp:${g.key}`)} strategy={verticalListSortingStrategy}>
                        <tbody>
                          {orderedGroups.map((g, gi) => (
                            <Fragment key={g.key}>
                              <SortableGroupRow
                                group={g}
                                rank={gi + 1}
                                expanded={expandedGroups.has(g.key)}
                                onToggleExpand={() => toggleExpand(g.key)}
                                onToggleGroup={handleGroupToggle}
                              />
                              {expandedGroups.has(g.key) && (
                                <SortableContext items={g.members.map(m => m.modelDbId)} strategy={verticalListSortingStrategy}>
                                  {g.members.map((m, mi) => (
                                    <SortableRow key={m.modelDbId} row={m} rank={mi + 1} onToggle={handleToggle} />
                                  ))}
                                </SortableContext>
                              )}
                            </Fragment>
                          ))}
                        </tbody>
                      </SortableContext>
                    </table>
                  </div>
                </DndContext>
              ) : (
                <div className="rounded-2xl border overflow-x-auto">
                  <table className="w-full text-sm">
                    {tableHead}
                    <tbody>
                      {orderedGroups.map((g, gi) => (
                        <Fragment key={g.key}>
                          <tr className={`border-b last:border-0 ${g.members.some(m => m.enabled) ? '' : 'opacity-50'}`}>
                            <GroupHeaderCells
                              group={g}
                              rank={gi + 1}
                              expanded={expandedGroups.has(g.key)}
                              onToggleExpand={() => toggleExpand(g.key)}
                              onToggleGroup={handleGroupToggle}
                            />
                          </tr>
                          {expandedGroups.has(g.key) && g.members.map((m, mi) => (
                            <tr key={m.modelDbId} className={`border-b last:border-0 bg-muted/20 ${m.enabled ? '' : 'opacity-50'}`}>
                              <RowContent row={m} rank={mi + 1} draggable={false} onToggle={handleToggle} />
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : isManual ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <div className="rounded-2xl border overflow-x-auto">
                  <table className="w-full text-sm">
                    {tableHead}
                    <SortableContext items={ordered.map(e => e.modelDbId)} strategy={verticalListSortingStrategy}>
                      <tbody>
                        {ordered.map((row, i) => (
                          <SortableRow key={row.modelDbId} row={row} rank={i + 1} onToggle={handleToggle} />
                        ))}
                      </tbody>
                    </SortableContext>
                  </table>
                </div>
              </DndContext>
            ) : (
              <div className="rounded-2xl border overflow-x-auto">
                <table className="w-full text-sm">
                  {tableHead}
                  <tbody>
                    {ordered.map((row, i) => (
                      <tr key={row.modelDbId} className={`border-b last:border-0 ${row.enabled ? '' : 'opacity-50'}`}>
                        <RowContent row={row} rank={i + 1} draggable={false} onToggle={handleToggle} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Floating action bar — fixed to the viewport so it's always visible,
                sliding up when there are unsaved changes and back down on save/discard. */}
            <FloatingBar show={hasChanges}>
              <span className="text-xs text-muted-foreground">{t('common.unsavedChanges')}</span>
              <Button variant="outline" size="sm" onClick={() => setLocalEntries(null)}>{t('common.discard')}</Button>
              <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t('common.saving') : t('common.saveChanges')}
              </Button>
            </FloatingBar>

            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">{t('models.hiddenNoKeys', { platforms: unconfiguredPlatforms.join(', ') })}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
