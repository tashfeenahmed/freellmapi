import { useEffect, useMemo, useRef, useState } from 'react'
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
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Boxes, ChevronDown, Search, X } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import {
  buildGroups,
  groupMatchesQuery,
  groupMaxContext,
  type FallbackEntry,
  type ModelGroupRow,
  type RateLimitUsageData,
  type RoutingData,
  type RoutingStrategy,
  type RoutingWeights,
  type KeySelectionStrategy,
  type Row,
  type TokenUsageData,
} from '@/lib/routing'
import { Button } from '@/components/ui/button'
import { CustomWeightsPopover } from '@/components/custom-weights-popover'
import { EmptyState } from '@/components/empty-state'
import { GettingStarted } from '@/components/getting-started'
import { GroupHeaderCells, ModelTableHead, SortableGroupRow } from '@/components/model-table'
import { TableSkeleton } from '@/components/ui/skeleton'
import { TokenUsageBar } from '@/components/token-usage-bar'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { Tooltip } from '@/components/tooltip'
import { PenaltyInspector } from '@/components/penalty-inspector'
import { PeakHoursControls } from '@/components/peak-hours-controls'
import { ChainManager } from '@/components/chain-manager'

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

// Minimum-context filter buckets for the Models page toolbar. `key` is the token
// threshold (0 = no filter); numeric labels are not localized (they're numbers).
const CTX_BUCKETS: { key: number; label?: string; tKey?: string }[] = [
  { key: 0, tKey: 'ctxAny' },
  { key: 32_000, label: '32K+' },
  { key: 128_000, label: '128K+' },
  { key: 1_000_000, label: '1M+' },
]

// Rows rendered up front; a sentinel below the table streams in the rest as
// you scroll. Keeps first paint cheap when the catalog grows into the
// hundreds without a virtualization dependency (which would fight dnd-kit).
const RENDER_CHUNK = 50

// The secondary routing knobs (key selection, exploration, peak hours) live
// behind a "More options" disclosure so the card opens on the strategy pills
// alone. Collapse state is remembered per browser, the same way the chain
// manager and the penalty inspector below remember theirs; a fresh install
// (no stored value) starts collapsed.
const OPTIONS_COLLAPSED_KEY = 'freellmapi.routingMoreOptions.collapsed'

function readOptionsCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(OPTIONS_COLLAPSED_KEY)
    return stored === null ? true : stored === '1'
  } catch {
    return true
  }
}


export default function FallbackPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Staged edits carry the chain they were made against, so switching chains
  // in the manager below discards them instead of letting one chain's unsaved
  // rows be saved into another (#1021).
  const [staged, setStaged] = useState<{ profileId: number | null; entries: FallbackEntry[] } | null>(null)
  const [optionsCollapsed, setOptionsCollapsed] = useState(readOptionsCollapsed)

  // Catalog search + filter state (#343).
  const [search, setSearch] = useState('')
  const [filterVision, setFilterVision] = useState(false)
  const [filterTools, setFilterTools] = useState(false)
  const [minContext, setMinContext] = useState(0)

  // The table edits the ACTIVE chain, so it is part of this query's identity
  // (#1021): keyed on 'fallback' alone, switching chains in the manager below
  // re-rendered the previous chain's rows from cache, and a save then wrote
  // them into the newly activated one. Held back until the active chain is
  // known so the first paint is already the right chain's.
  const { data: active, isPending: activePending } = useQuery<{ activeProfileId: number | null }>({
    queryKey: ['profiles', 'active'],
    queryFn: () => apiFetch('/api/profiles/active'),
  })
  const activeProfileId = active?.activeProfileId ?? null

  const { data: entries = [], isLoading: entriesLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback', 'chain', activeProfileId],
    // The chain id rides in the request itself (#1047): keyed-but-unpinned, a
    // refetch racing an activation fetched "whichever chain is active by now"
    // into the OLD chain's cache entry, and switching A→B→A then rendered (and
    // could save) B's rows under A's name until a hard refresh.
    queryFn: () => apiFetch(activeProfileId != null ? `/api/fallback?profile=${activeProfileId}` : '/api/fallback'),
    enabled: !activePending,
  })
  const isLoading = activePending || entriesLoading

  // Staged edits are DISCARDED when the active chain changes, not just hidden
  // (#1047): merely masking them meant switching A→B→A resurrected A's stale
  // unsaved rows over freshly fetched data, with only a refresh clearing them.
  useEffect(() => {
    setStaged(prev => (prev && prev.profileId !== activeProfileId ? null : prev))
  }, [activeProfileId])

  const localEntries = staged && staged.profileId === activeProfileId ? staged.entries : null
  const setLocalEntries = (entries: FallbackEntry[] | null) =>
    setStaged(entries === null ? null : { profileId: activeProfileId, entries })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
  })

  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
    refetchInterval: 15_000,
  })

  // Time-window rate-limit usage (#876). One observer and one poll timer for the
  // whole table — the row component reads it from a map instead of subscribing
  // per row, which on a large catalog was hundreds of observers and timers.
  const { data: rateLimitUsage } = useQuery<RateLimitUsageData>({
    queryKey: ['fallback', 'rate-limit-usage'],
    queryFn: () => apiFetch('/api/fallback/rate-limit-usage'),
    refetchInterval: 15_000,
  })
  const rateUsageByModel = useMemo(
    () => new Map((rateLimitUsage?.rows ?? []).map(r => [r.modelDbId, r])),
    [rateLimitUsage],
  )

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setLocalEntries(null)
    },
  })

  const strategyMutation = useMutation({
    mutationFn: (payload: {
      strategy: RoutingStrategy; weights?: RoutingWeights; exploreEnabled?: boolean
      peakHoursAdjust?: boolean; peakStartHour?: number; peakEndHour?: number; peakTimezone?: string
      keySelectionStrategy?: KeySelectionStrategy
    }) =>
      apiFetch('/api/fallback/routing', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] }),
  })

  const strategy: RoutingStrategy = routing?.strategy ?? 'balanced'
  const keySelection: KeySelectionStrategy = routing?.keySelectionStrategy ?? 'auto'
  const isManual = strategy === 'priority'

  // Merge fallback metadata with live scores, keyed by model. Memoized (#1047):
  // recomputing these over the whole catalog on every render — and the page
  // renders once per landing query plus once per 15s poll — was a large part of
  // the "absurdly slow" feel on big catalogs.
  const scoreById = useMemo(
    () => new Map((routing?.scores ?? []).map(s => [s.modelDbId, s])),
    [routing?.scores],
  )
  const allEntries = useMemo(() => localEntries ?? entries, [localEntries, entries])
  const configured = useMemo(() => allEntries.filter(e => e.keyCount > 0), [allEntries])
  const unconfiguredPlatforms = useMemo(
    () => [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))],
    [allEntries],
  )

  // Entry fields win on overlap: the routing snapshot also carries `enabled`
  // (and identity fields), which would otherwise clobber unsaved local toggles.
  const rows: Row[] = useMemo(
    () => configured.map(e => ({ ...(scoreById.get(e.modelDbId) ?? {}), ...e })),
    [configured, scoreById],
  )

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleSave() {
    saveMutation.mutate(allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled })))
  }

  function toggleOptions() {
    setOptionsCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem(OPTIONS_COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  const hasChanges = localEntries !== null

  // ── Model unification: a model served by several providers is always shown as
  // one logical row that links to its own page (the on/off toggle was removed). ─
  const orderedGroups = useMemo(() => buildGroups(rows, isManual), [rows, isManual])

  // Catalog search + filters (#343). Filtering operates on whole logical-model
  // groups; rank stays the model's position in the full chain so the numbers
  // don't renumber as you filter. Drag-to-reorder is only offered over the full,
  // unfiltered manual chain (reordering a filtered subset would be ambiguous).
  const rankByKey = useMemo(() => new Map(orderedGroups.map((g, i) => [g.key, i + 1])), [orderedGroups])
  const query = search.trim().toLowerCase()
  const filtersActive = query !== '' || filterVision || filterTools || minContext > 0
  const visibleGroups = useMemo(() => orderedGroups.filter(g => {
    if (filterVision && !g.members.some(m => m.supportsVision)) return false
    if (filterTools && !g.members.some(m => m.supportsTools)) return false
    if (minContext > 0 && groupMaxContext(g.members) < minContext) return false
    if (query && !groupMatchesQuery(g, query)) return false
    return true
  }), [orderedGroups, filterVision, filterTools, minContext, query])
  const draggable = isManual && !filtersActive

  // Progressive rendering: grow the row budget whenever the sentinel below the
  // table scrolls near the viewport (drag autoscroll extends it too).
  const [renderLimit, setRenderLimit] = useState(RENDER_CHUNK)
  const renderedGroups = visibleGroups.slice(0, renderLimit)
  const hasMoreRows = visibleGroups.length > renderLimit
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hasMoreRows) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      hits => {
        if (hits.some(h => h.isIntersecting)) setRenderLimit(l => l + RENDER_CHUNK)
      },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMoreRows, renderLimit])

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

  // Bulk on/off over what is currently on screen (#895). Curating a chain by
  // hand means turning most of the catalog off, which one row at a time over
  // 200 models nobody does. It deliberately follows the filters: "search groq,
  // disable all" is the useful gesture, and touching hidden rows would be a
  // surprise. Like every other edit here it stages into localEntries and waits
  // for Save.
  const visibleMemberIds = visibleGroups.flatMap(g => g.members.map(m => m.modelDbId))
  const visibleEnabledCount = visibleGroups.filter(g => g.members.some(m => m.enabled)).length

  function handleBulkToggle(enabled: boolean) {
    const ids = new Set(visibleMemberIds)
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
        {/* First-run checklist: hides itself once the install has keys + a request */}
        <GettingStarted />

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
                {/* These numbers are not the preset's while the peak-hours
                    adjustment is firing, so say so right where they are read. */}
                {routing.peakAdjusted && (
                  <Tooltip text={t('strategies.peakActiveHint')}>
                    <span className="ml-1 cursor-help underline decoration-dotted underline-offset-2">
                      {t('strategies.peakActive')}
                    </span>
                  </Tooltip>
                )}
              </span>
            )}
          </div>

          {/* Pills left, the quiet "More options" disclosure right. Everything
              secondary hangs off that toggle so the card reads as one choice. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
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

            <button
              type="button"
              onClick={toggleOptions}
              aria-expanded={!optionsCollapsed}
              className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {t('strategies.moreOptions')}
              <ChevronDown className={`size-3.5 transition-transform ${optionsCollapsed ? '-rotate-90' : ''}`} />
            </button>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            {isManual ? t('strategies.modeManualHint') : t('strategies.modeScoreHint')}
          </p>

          {!optionsCollapsed && (
            <div className="mt-3 flex flex-col items-start gap-2 border-t pt-3">
              {/* Key selection (#919). A separate knob from the strategy above:
                  that one ranks MODELS, this one picks between several keys of
                  the same provider. Shown in every mode — manual chain order
                  still leaves the choice of key open. */}
              <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <span>{t('strategies.keySelection')}</span>
                <select
                  value={keySelection}
                  disabled={strategyMutation.isPending}
                  onChange={e => strategyMutation.mutate({ strategy, keySelectionStrategy: e.target.value as KeySelectionStrategy })}
                  className="rounded-lg border bg-background px-2 py-1.5 text-xs text-foreground"
                >
                  <option value="auto">{t('strategies.keySelectionAuto')}</option>
                  <option value="least-remaining">{t('strategies.keySelectionLeastRemaining')}</option>
                </select>
                <Tooltip text={t('strategies.keySelectionHint')}>
                  <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
                </Tooltip>
              </label>

              {/* Exploration toggle (#685 follow-up): a niche knob that gives
                  unmeasured models a guaranteed chance to be tried so they build
                  reliability/speed data. Hidden in Manual mode, where
                  routeRequest ignores it. */}
              {!isManual && (
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={routing?.exploreEnabled ?? false}
                    disabled={strategyMutation.isPending}
                    onChange={e => strategyMutation.mutate({ strategy, exploreEnabled: e.target.checked })}
                    className="size-3.5 accent-foreground"
                  />
                  <span>{t('strategies.explore')}</span>
                  <Tooltip text={t('strategies.exploreHint')}>
                    <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
                  </Tooltip>
                </label>
              )}

              {/* Peak-hours adjustment (#760): an opt-in tweak to the preset
                  weights, and off it does nothing at all. Its "(peak hours)"
                  marker on the weight summary above stays visible either way —
                  that one explains live behaviour. */}
              {!isManual && routing && (
                <PeakHoursControls
                  routing={routing}
                  strategy={strategy}
                  saving={strategyMutation.isPending}
                  onSave={p => strategyMutation.mutate({ strategy, ...p })}
                />
              )}
            </div>
          )}

        </section>

        {/* Named fallback chains (#960/#895): list/create/activate/delete.
            Activating a chain makes the table below edit that chain. */}
        <ChainManager />

        <PenaltyInspector />

        {/* Unified routing / fallback table */}
        {isLoading ? (
          <TableSkeleton rows={8} />
        ) : orderedGroups.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title={t('models.noModelsTitle')}
            description={<>{t('models.noModelsBefore')}<Link to="/keys" className="underline text-foreground">{t('models.keysPageLink')}</Link>{t('models.noModelsAfter')}</>}
            action={
              <Link to="/keys">
                <Button size="sm">{t('setup.step1Cta')}</Button>
              </Link>
            }
          />
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
                <div className="inline-flex items-center gap-1 rounded-xl border p-1" role="group" aria-label={t('models.bulkToggle')}>
                  <Tooltip text={t('models.enableAllHint')}>
                    <button
                      onClick={() => handleBulkToggle(true)}
                      disabled={visibleEnabledCount === visibleGroups.length}
                      className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      {t('models.enableAll')}
                    </button>
                  </Tooltip>
                  <Tooltip text={t('models.disableAllHint')}>
                    <button
                      onClick={() => handleBulkToggle(false)}
                      disabled={visibleEnabledCount === 0}
                      className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      {t('models.disableAll')}
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {t('models.enabledOfShown', { enabled: visibleEnabledCount, shown: visibleGroups.length })}
            </p>

            {filtersActive && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('models.showingCount', { shown: visibleGroups.length, total: orderedGroups.length })}</span>
                <button onClick={clearFilters} className="underline hover:text-foreground">{t('models.clearFilters')}</button>
              </div>
            )}

            {/* DndContext must wrap OUTSIDE the table: it renders hidden a11y
                live-region <div>s, which are invalid as direct <table> children. */}
            {visibleGroups.length === 0 ? (
              <EmptyState
                title={t('models.noMatches')}
                action={
                  <Button variant="outline" size="sm" onClick={clearFilters}>{t('models.clearFilters')}</Button>
                }
              />
            ) : draggable ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupedDragEnd}>
                <div className="rounded-2xl border overflow-x-auto">
                  <table className="w-full text-sm">
                    <ModelTableHead />
                    <SortableContext items={renderedGroups.map(g => `grp:${g.key}`)} strategy={verticalListSortingStrategy}>
                      <tbody>
                        {renderedGroups.map(g => (
                          <SortableGroupRow key={g.key} group={g} rank={rankByKey.get(g.key) ?? 0} onToggleGroup={handleGroupToggle} allRows={rows} rateUsage={rateUsageByModel} />
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
                    {renderedGroups.map(g => (
                      <tr
                        key={g.key}
                        onClick={() => navigate(`/models/chat/${encodeURIComponent(g.members[0].canonicalId ?? g.members[0].modelId)}`)}
                        className={`group/row border-b last:border-0 cursor-pointer transition-colors hover:[&>td]:bg-muted/50 [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg ${g.members.some(m => m.enabled) ? '' : 'opacity-50'}`}
                      >
                        <GroupHeaderCells group={g} rank={rankByKey.get(g.key) ?? 0} onToggleGroup={handleGroupToggle} allRows={rows} rateUsage={rateUsageByModel} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Invisible sentinel: when it nears the viewport the next row chunk
                renders. Present only while rows remain, so IO never fires idle. */}
            {hasMoreRows && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}

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
