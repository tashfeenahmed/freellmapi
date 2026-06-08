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
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { Tooltip } from '@/components/tooltip'
import { useTranslation } from 'react-i18next'

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
  supportsVision: boolean
  supportsTools: boolean
  keyCount: number
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

const STRATEGY_KEYS: RoutingStrategy[] = ['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']

const STRATEGY_BLURB_KEYS: Record<string, string> = {
  priority: 'fallback.strategy.manualBlurb',
  balanced: 'fallback.strategy.balancedBlurb',
  smartest: 'fallback.strategy.smartestBlurb',
  fastest: 'fallback.strategy.fastestBlurb',
  reliable: 'fallback.strategy.reliableBlurb',
  custom: 'fallback.strategy.customBlurb',
}

// Slider axes share the colors used by the score table columns below.
const WEIGHT_AXIS_KEYS: (keyof RoutingWeights)[] = ['reliability', 'speed', 'intelligence']

// Slider popover for the 'custom' strategy. Sliders are independent (0-100)
// and the server renormalizes any vector, so we just show each axis's
// effective share live. Nothing is saved until Apply is pressed.
function CustomWeightsPopover({ saved, onSave, saving }: {
  saved: RoutingWeights
  onSave: (w: RoutingWeights) => void
  saving: boolean
}) {
  const { t } = useTranslation()
  const [values, setValues] = useState<RoutingWeights>(() => fromSaved(saved))
  const [dirty, setDirty] = useState(false)

  function fromSaved(w: RoutingWeights): RoutingWeights {
    return {
      reliability: Math.round(w.reliability * 100),
      speed: Math.round(w.speed * 100),
      intelligence: Math.round(w.intelligence * 100),
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
        {t('fallback.adjust')}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t('fallback.customWeights')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('fallback.customWeightsDesc')}
            </p>
          </div>
          {WEIGHT_AXIS_KEYS.map(axis => {
            const share = sum > 0 ? Math.round((values[axis] / sum) * 100) : 0
            return (
              <div key={axis}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: axis === 'reliability' ? '#22c55e' : axis === 'speed' ? '#3b82f6' : '#a855f7' }} />
                    {t(`fallback.${axis}`)}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{share}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={values[axis]}
                  onChange={e => update(axis, Number(e.target.value))}
                  className="w-full cursor-pointer"
                  style={{ accentColor: axis === 'reliability' ? '#22c55e' : axis === 'speed' ? '#3b82f6' : '#a855f7' }}
                  aria-label={`${t(`fallback.${axis}`)} weight`}
                />
              </div>
            )
          })}
          {sum <= 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t('fallback.weightBelowZero')}
            </p>
          )}
          <Button
            size="sm"
            className="w-full"
            disabled={!dirty || sum <= 0 || saving}
            onClick={apply}
          >
            {saving ? t('fallback.applying') : dirty ? t('fallback.apply') : t('fallback.applied')}
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
  const { t } = useTranslation()
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
        <h2 className="text-sm font-medium">{t('fallback.monthlyBudget')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">{formatTokens(remaining)}</span> {t('fallback.remaining')}
          <span className="mx-1.5">·</span>
          {remainingPct}% of {formatTokens(totalBudget)}
        </span>
      </div>

      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {modelsWithWidth.map((m, i) => (
          <div
            key={i}
            title={`${m.displayName} (${m.platform}): ${formatTokens(m.remainingTokens)} ${t('fallback.remaining')}`}
            style={{
              width: `${m.widthPct}%`,
              backgroundColor: platformColors[m.platform] ?? '#94a3b8',
            }}
          />
        ))}
        {totalUsed > 0 && (
          <div
            title={`${t('keys.loadingKeys')} ${formatTokens(totalUsed)}`}
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
          {expanded ? t('fallback.showLess') : t('fallback.showAll', { count: models.length })}
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
  const { t } = useTranslation()
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
              title={t('fallback.vision')}
              className="text-[10px] rounded-full px-1.5 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400"
            >
              {t('fallback.vision')}
            </span>
          )}
          {row.supportsTools && (
            <span
              title={t('fallback.tools')}
              className="text-[10px] rounded-full px-1.5 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400"
            >
              {t('fallback.tools')}
            </span>
          )}
          {(row.penalty ?? 0) > 0 && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">−{row.penalty} {t('fallback.penalty')}</span>
          )}
          {row.totalRequests !== undefined && row.totalRequests > 0 && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">{row.totalRequests} {t('fallback.obs')}</span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground/70 tabular-nums mt-0.5">
          {row.monthlyTokenBudget} {t('fallback.tokensMo')}
          {row.rpmLimit ? ` · ${row.rpmLimit} ${t('fallback.rpm')}` : ''}
          {row.rpdLimit ? ` · ${row.rpdLimit} ${t('fallback.rpd')}` : ''}
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
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.modelDbId })
  const handle = (
    <button
      {...attributes}
      {...listeners}
      className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
      aria-label={t('fallback.dragReorder')}
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

export default function FallbackPage() {
  const { t } = useTranslation()
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

  const tableHead = (
    <thead>
      <tr className="text-left text-muted-foreground border-b">
        <th className="py-2 pl-3 pr-1 w-6"></th>
        <th className="py-2 pr-2 w-6 text-center font-medium">#</th>
        <th className="py-2 pr-3 font-medium">{t('fallback.model')}</th>
        <th className="py-2 pr-3 font-medium">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: '#22c55e' }} />{t('fallback.reliability')}</span>
        </th>
        <th className="py-2 pr-3 font-medium">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: '#3b82f6' }} />{t('fallback.speed')}</span>
        </th>
        <th className="py-2 pr-3 font-medium">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: '#a855f7' }} />{t('fallback.intelligence')}</span>
        </th>
        <th className="py-2 pr-3 font-medium">
          <Tooltip text={t('fallback.guardrailsHint')}>
            <span className="underline decoration-dotted underline-offset-2 cursor-help">{t('fallback.guardrails')}</span>
          </Tooltip>
        </th>
        <th className="py-2 pr-3 font-medium text-right">
          <Tooltip text={t('fallback.scoreHint')}>
            <span className="underline decoration-dotted underline-offset-2 cursor-help">{t('fallback.score')}</span>
          </Tooltip>
        </th>
        <th className="py-2 pr-3 font-medium text-right">{t('fallback.on')}</th>
      </tr>
    </thead>
  )

  return (
    <div>
      <PageHeader
        title={t('fallback.pageTitle')}
        description={t('fallback.pageDesc')}
        divider={false}
        actions={<ModelsTabs />}
      />

      <div className="space-y-6">
        {/* Monthly token budget — moved to the top */}
        {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} />}

        {/* Strategy selector */}
        <section className="rounded-3xl border bg-card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium">{t('fallback.routingStrategy')}</h2>
            {routing?.weights && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('fallback.reliability')} {Math.round(routing.weights.reliability * 100)}% ·
                {' '}{t('fallback.speed')} {Math.round(routing.weights.speed * 100)}% ·
                {' '}{t('fallback.intelligence')} {Math.round(routing.weights.intelligence * 100)}%
              </span>
            )}
          </div>

          <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border p-1">
            {STRATEGY_KEYS.map((key) => {
              const labelKey = `fallback.strategy.${key}` as const
              const isCurrent = key === strategy
              return (
                <Tooltip key={key} text={t(STRATEGY_BLURB_KEYS[key])}>
                  <button
                    disabled={strategyMutation.isPending}
                    onClick={() => strategyMutation.mutate({ strategy: key })}
                    className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                      isCurrent
                        ? 'bg-foreground text-background font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`}
                  >
                    {t(labelKey)}
                  </button>
                </Tooltip>
              )
            })}
            {strategy === 'custom' && routing && (
              <CustomWeightsPopover
                saved={routing.customWeights}
                saving={strategyMutation.isPending}
                onSave={w => strategyMutation.mutate({ strategy: 'custom', weights: w })}
              />
            )}
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            {isManual
              ? t('fallback.manualMode')
              : t('fallback.scoreMode')}
          </p>
        </section>

        {/* Unified routing / fallback table */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : ordered.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {t('fallback.noModels')}{' '}
              <a href="/keys" className="underline text-foreground">{t('keys.pageTitle').toLowerCase()}</a>{' '}
              {t('fallback.pageDesc').split('.')[1]?.trim()}
            </p>
          </div>
        ) : (
          <>
            {/* DndContext must wrap OUTSIDE the table: it renders hidden a11y
                live-region <div>s, which are invalid as direct <table> children. */}
            {isManual ? (
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
              <span className="text-xs text-muted-foreground">{t('fallback.unsaved')}</span>
              <Button variant="outline" size="sm" onClick={() => setLocalEntries(null)}>{t('fallback.discard')}</Button>
              <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t('fallback.saving') : t('fallback.saveChanges')}
              </Button>
            </FloatingBar>

            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('fallback.hiddenNoKeys', { platforms: unconfiguredPlatforms.join(', ') })}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
