import { useEffect, useState, useRef, type ReactNode } from 'react'
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
import { ChevronDown, SlidersHorizontal, Search, X } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/copy-button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { Tooltip } from '@/components/tooltip'
import { PenaltyInspector } from '@/components/penalty-inspector'

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

type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom'

type RoutingWeights = { reliability: number; speed: number; intelligence: number }

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

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// Compact context-window label (whole-number K/M, base 1000): 8000 → "8K",
// 128000 → "128K", 1_000_000 → "1M". Used by the catalog context badge/filter.
function formatContext(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

// The largest context window across a logical model's providers.
function groupMaxContext(members: Row[]): number {
  return Math.max(0, ...members.map(m => m.contextWindow ?? 0))
}

// Minimum-context filter buckets for the Models page toolbar. `key` is the token
// threshold (0 = no filter); numeric labels are not localized (they're numbers).
const CTX_BUCKETS: { key: number; label?: string; tKey?: string }[] = [
  { key: 0, tKey: 'ctxAny' },
  { key: 32_000, label: '32K+' },
  { key: 128_000, label: '128K+' },
  { key: 1_000_000, label: '1M+' },
]

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
  routeway:    '#14b8a6',
  bazaarlink:  '#e11d48',
  ainative:    '#22c55e',
}

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
function GroupHeaderCells({ group, rank, dragHandle, onToggleGroup }: {
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
              ? <span className="text-xs text-muted-foreground">{group.members[0].platform}</span>
              : <Tooltip text={t('models.servedBy', { providers: group.members.map(m => m.platform).join(', ') })}>
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
            <CopyButton text={copyId} className="size-6" label={t('models.copyModelId')} />
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

function SortableGroupRow({ group, rank, onToggleGroup }: {
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
      className={`border-b last:border-0 bg-card cursor-pointer transition-colors hover:[&>td]:bg-muted/50 [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg ${isDragging ? 'opacity-50' : ''} ${anyEnabled ? '' : 'opacity-50'}`}
    >
      <GroupHeaderCells group={group} rank={rank} dragHandle={handle} onToggleGroup={onToggleGroup} />
    </tr>
  )
}

export default function FallbackPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)

  // Catalog search + filter state (#343).
  const [search, setSearch] = useState('')
  const [filterVision, setFilterVision] = useState(false)
  const [filterTools, setFilterTools] = useState(false)
  const [minContext, setMinContext] = useState(0)

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

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleSave() {
    saveMutation.mutate(allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled })))
  }

  const hasChanges = localEntries !== null

  // ── Model unification: a model served by several providers is always shown as
  // one logical row that links to its own page (the on/off toggle was removed). ─
  const orderedGroups = buildGroups(rows, isManual)

  // Catalog search + filters (#343). Filtering operates on whole logical-model
  // groups; rank stays the model's position in the full chain so the numbers
  // don't renumber as you filter. Drag-to-reorder is only offered over the full,
  // unfiltered manual chain (reordering a filtered subset would be ambiguous).
  const rankByKey = new Map(orderedGroups.map((g, i) => [g.key, i + 1]))
  const query = search.trim().toLowerCase()
  const filtersActive = query !== '' || filterVision || filterTools || minContext > 0
  const visibleGroups = orderedGroups.filter(g => {
    if (filterVision && !g.members.some(m => m.supportsVision)) return false
    if (filterTools && !g.members.some(m => m.supportsTools)) return false
    if (minContext > 0 && groupMaxContext(g.members) < minContext) return false
    if (query) {
      const hay = [
        g.label,
        g.members[0].canonicalId ?? '',
        ...g.members.map(m => m.platform),
        ...g.members.map(m => m.displayName),
        ...g.members.map(m => m.modelId),
      ].join(' ').toLowerCase()
      if (!hay.includes(query)) return false
    }
    return true
  })
  const draggable = isManual && !filtersActive
  function clearFilters() {
    setSearch('')
    setFilterVision(false)
    setFilterTools(false)
    setMinContext(0)
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

  // Reorder models (the failover priority order). Providers within a model are
  // ordered by the active strategy and managed on the model's own page.
  function handleGroupedDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldI = orderedGroups.findIndex(g => `grp:${g.key}` === String(active.id))
    const newI = orderedGroups.findIndex(g => `grp:${g.key}` === String(over.id))
    if (oldI < 0 || newI < 0) return
    persistGroupOrder(arrayMove(orderedGroups, oldI, newI))
  }

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

        <PenaltyInspector />

        {/* Unified routing / fallback table */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : orderedGroups.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {t('models.noModelsBefore')}<a href="/keys" className="underline text-foreground">{t('models.keysPageLink')}</a>{t('models.noModelsAfter')}
            </p>
          </div>
        ) : (
          <>
            {/* Catalog toolbar: search + capability/context filters (#343) */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t('models.searchPlaceholder')}
                  aria-label={t('models.searchPlaceholder')}
                  className="w-full rounded-xl border bg-card py-1.5 pl-9 pr-8 text-sm outline-none transition-colors focus:border-foreground/30"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    aria-label={t('models.clearSearch')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setFilterVision(v => !v)}
                  aria-pressed={filterVision}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${filterVision ? 'bg-foreground text-background border-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {t('models.vision')}
                </button>
                <button
                  onClick={() => setFilterTools(v => !v)}
                  aria-pressed={filterTools}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${filterTools ? 'bg-foreground text-background border-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {t('models.tools')}
                </button>
                <div className="inline-flex items-center gap-1 rounded-xl border p-1" role="group" aria-label={t('models.ctxTitle')}>
                  {CTX_BUCKETS.map(b => (
                    <button
                      key={b.key}
                      onClick={() => setMinContext(b.key)}
                      className={`px-2.5 py-1 text-xs rounded-lg transition-colors tabular-nums ${minContext === b.key ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                    >
                      {b.tKey ? t(`models.${b.tKey}`) : b.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filtersActive && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('models.showingCount', { shown: visibleGroups.length, total: orderedGroups.length })}</span>
                <button onClick={clearFilters} className="underline hover:text-foreground">{t('models.clearFilters')}</button>
              </div>
            )}

            {/* DndContext must wrap OUTSIDE the table: it renders hidden a11y
                live-region <div>s, which are invalid as direct <table> children. */}
            {visibleGroups.length === 0 ? (
              <div className="rounded-3xl border border-dashed p-8 text-center">
                <p className="text-sm text-muted-foreground">{t('models.noMatches')}</p>
              </div>
            ) : draggable ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupedDragEnd}>
                <div className="rounded-2xl border overflow-x-auto">
                  <table className="w-full text-sm">
                    <ModelTableHead />
                    <SortableContext items={visibleGroups.map(g => `grp:${g.key}`)} strategy={verticalListSortingStrategy}>
                      <tbody>
                        {visibleGroups.map(g => (
                          <SortableGroupRow key={g.key} group={g} rank={rankByKey.get(g.key) ?? 0} onToggleGroup={handleGroupToggle} />
                        ))}
                      </tbody>
                    </SortableContext>
                  </table>
                </div>
              </DndContext>
            ) : (
              <div className="rounded-2xl border overflow-x-auto">
                <table className="w-full text-sm">
                  <ModelTableHead />
                  <tbody>
                    {visibleGroups.map(g => (
                      <tr
                        key={g.key}
                        onClick={() => navigate(`/models/chat/${encodeURIComponent(g.members[0].canonicalId ?? g.members[0].modelId)}`)}
                        className={`border-b last:border-0 cursor-pointer transition-colors hover:[&>td]:bg-muted/50 [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg ${g.members.some(m => m.enabled) ? '' : 'opacity-50'}`}
                      >
                        <GroupHeaderCells group={g} rank={rankByKey.get(g.key) ?? 0} onToggleGroup={handleGroupToggle} />
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
