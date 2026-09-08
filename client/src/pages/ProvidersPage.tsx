import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Search,
  Plus,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Server,
  KeyRound,
  Sparkles,
  RefreshCw,
  Trash2,
  Check,
  X,
  AlertCircle,
  Loader2,
  Wrench,
  Layers,
  Copy,
  Pencil,
  Zap,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { TableSkeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { ConfirmButton } from '@/components/confirm-button'
import { Tooltip } from '@/components/tooltip'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { AddKeyDialog } from '@/components/keys/add-key-dialog'
import { CopyKeyDialog } from '@/components/keys/copy-key-dialog'
import { AddModelDialog } from '@/components/providers/add-model-dialog'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { statusDot, statusLabelKey } from '@/components/keys/shared'
import type { ApiKey, Model, Platform, ModelTestResult } from '../../../shared/types'
import {
  groupProviders,
  filterGroupedProviders,
  getHiddenProviders,
  setHiddenProviders,
  getHiddenModels,
  setHiddenModels,
  getCollapsedProviders,
  setCollapsedProviders,
} from '@/lib/providers'

type StatusFilter = 'all' | 'configured' | 'healthy' | 'issues' | 'unconfigured'

interface ModelTestState {
  loading: boolean
  lastTestedAt?: number
  result?: {
    success: boolean
    latencyMs: number
    error?: string
  }
}

export default function ProvidersPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // Data fetching
  const { data: keys = [], isLoading: isLoadingKeys } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: models = [], isLoading: isLoadingModels } = useQuery<Model[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })

  // Local storage persisted state
  const [hiddenProviders, setHiddenProvidersState] = useState<Set<string>>(() => getHiddenProviders())
  const [hiddenModels, setHiddenModelsState] = useState<Set<string>>(() => getHiddenModels())
  const [collapsedProviders, setCollapsedProvidersState] = useState<Set<string>>(() => getCollapsedProviders())

  // Toolbar & filter state
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [showHiddenProviders, setShowHiddenProviders] = useState(false)
  const [showHiddenModels, setShowHiddenModels] = useState(false)

  // Dialog state
  const [addKeyOpen, setAddKeyOpen] = useState(false)
  const [addKeyPlatform, setAddKeyPlatform] = useState<Platform | undefined>(undefined)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [addModelPlatform, setAddModelPlatform] = useState<string | undefined>(undefined)
  const [copyKey, setCopyKey] = useState<{ id: number; maskedKey: string } | null>(null)

  // In-line key editing
  const [editingKeyId, setEditingKeyId] = useState<number | null>(null)
  const [editingKeyLabel, setEditingKeyLabel] = useState('')

  // Model test tracking: modelDbId -> test state
  const [modelTests, setModelTests] = useState<Record<number, ModelTestState>>({})

  // Update collapsed providers persistence
  const toggleCollapse = (platformKey: string) => {
    setCollapsedProvidersState(prev => {
      const next = new Set(prev)
      if (next.has(platformKey)) next.delete(platformKey)
      else next.add(platformKey)
      setCollapsedProviders(next)
      return next
    })
  }

  const collapseAll = () => {
    const allKeys = new Set(allGrouped.map(g => g.endpointScope ? `${g.platform}:${g.endpointScope}` : g.platform))
    setCollapsedProvidersState(allKeys)
    setCollapsedProviders(allKeys)
  }

  const expandAll = () => {
    const empty = new Set<string>()
    setCollapsedProvidersState(empty)
    setCollapsedProviders(empty)
  }

  // Toggle hide provider
  const toggleHideProvider = (platformKey: string) => {
    setHiddenProvidersState(prev => {
      const next = new Set(prev)
      if (next.has(platformKey)) {
        next.delete(platformKey)
        toast.info(t('providers.providerUnhidden'))
      } else {
        next.add(platformKey)
        toast.info(t('providers.providerHidden'))
      }
      setHiddenProviders(next)
      return next
    })
  }

  // Toggle hide model
  const toggleHideModel = (modelId: string) => {
    setHiddenModelsState(prev => {
      const next = new Set(prev)
      if (next.has(modelId)) {
        next.delete(modelId)
        toast.info(t('providers.modelUnhidden'))
      } else {
        next.add(modelId)
        toast.info(t('providers.modelHidden'))
      }
      setHiddenModels(next)
      return next
    })
  }

  // Mutations
  const toggleKeyMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
    onError: (err: any) => {
      toast.error(err?.message || t('providers.actionFailed'))
    },
  })

  const updateKeyMutation = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) =>
      apiFetch(`/api/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      setEditingKeyId(null)
      toast.success(t('providers.keyUpdated'))
    },
    onError: (err: any) => {
      toast.error(err?.message || t('providers.actionFailed'))
    },
  })

  const deleteKeyMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      toast.success(t('providers.keyDeleted'))
    },
    onError: (err: any) => {
      toast.error(err?.message || t('providers.actionFailed'))
    },
  })

  const checkKeyMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/health/check/${id}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      toast.success(t('providers.healthChecked'))
    },
    onError: (err: any) => {
      toast.error(err?.message || t('providers.actionFailed'))
    },
  })

  const toggleModelMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/models/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
    onError: (err: any) => {
      toast.error(err?.message || t('providers.actionFailed'))
    },
  })

  const deleteModelMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      toast.success(t('providers.modelDeleted'))
    },
    onError: (err: any) => {
      toast.error(err?.message || t('providers.actionFailed'))
    },
  })

  // Test Model handler
  const handleTestModel = async (model: Model) => {
    const current = modelTests[model.id]
    const now = Date.now()
    if (current?.loading) return
    if (current?.lastTestedAt && now - current.lastTestedAt < 5000) {
      const wait = Math.ceil((5000 - (now - current.lastTestedAt)) / 1000)
      toast.error(t('providers.testThrottled', { seconds: wait }))
      return
    }

    setModelTests(prev => ({
      ...prev,
      [model.id]: { loading: true, lastTestedAt: now },
    }))

    try {
      const res = await apiFetch<ModelTestResult>(`/api/models/${model.id}/test`, {
        method: 'POST',
      })
      setModelTests(prev => ({
        ...prev,
        [model.id]: {
          loading: false,
          lastTestedAt: Date.now(),
          result: {
            success: res.success,
            latencyMs: res.latencyMs,
            error: res.error,
          },
        },
      }))
      if (res.success) {
        toast.success(t('providers.testPassed', { latency: res.latencyMs }))
      } else {
        toast.error(res.error || t('providers.testFailed'))
      }
    } catch (err: any) {
      setModelTests(prev => ({
        ...prev,
        [model.id]: {
          loading: false,
          lastTestedAt: Date.now(),
          result: {
            success: false,
            latencyMs: 0,
            error: err?.message || t('providers.testFailed'),
          },
        },
      }))
      toast.error(err?.message || t('providers.testFailed'))
    }
  }

  // Grouping & Filtering
  const allGrouped = useMemo(() => {
    return groupProviders(keys, models)
  }, [keys, models])

  const filteredGrouped = useMemo(() => {
    return filterGroupedProviders(allGrouped, {
      search,
      statusFilter,
      showHiddenProviders,
      showHiddenModels,
      hiddenProviderIds: hiddenProviders,
      hiddenModelIds: hiddenModels,
    })
  }, [allGrouped, search, statusFilter, showHiddenProviders, showHiddenModels, hiddenProviders, hiddenModels])

  // Count summaries for filter pills
  const counts = useMemo(() => {
    let configured = 0
    let healthy = 0
    let issues = 0
    let unconfigured = 0
    for (const g of allGrouped) {
      if (g.summary.isConfigured) configured++
      else unconfigured++
      if (g.summary.status === 'healthy') healthy++
      if (g.summary.status === 'issues' || g.summary.status === 'rate_limited') issues++
    }
    return {
      all: allGrouped.length,
      configured,
      healthy,
      issues,
      unconfigured,
    }
  }, [allGrouped])

  if (isLoadingKeys || isLoadingModels) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-48 animate-pulse rounded-lg bg-muted" />
        <TableSkeleton rows={5} />
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {t('providers.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('providers.description')}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAddModelPlatform(undefined)
              setAddModelOpen(true)
            }}
          >
            <Sparkles className="size-4 text-primary" />
            {t('providers.addCustomModel')}
          </Button>

          <Button
            size="sm"
            onClick={() => {
              setAddKeyPlatform(undefined)
              setAddKeyOpen(true)
            }}
          >
            <Plus className="size-4" />
            {t('keys.addKey')}
          </Button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border/80 bg-card/50 p-4 backdrop-blur-sm shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Search */}
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('providers.searchPlaceholder')}
              className="h-9 pl-9 text-sm"
            />
          </div>

          {/* Expand / Collapse all */}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="xs" onClick={expandAll} className="text-xs text-muted-foreground hover:text-foreground">
              {t('providers.expandAll')}
            </Button>
            <span className="text-muted-foreground/40">|</span>
            <Button variant="ghost" size="xs" onClick={collapseAll} className="text-xs text-muted-foreground hover:text-foreground">
              {t('providers.collapseAll')}
            </Button>
          </div>
        </div>

        {/* Status segmented control & Hidden Toggles */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-border/50">
          <SegmentedControl<StatusFilter>
            value={statusFilter}
            onValueChange={setStatusFilter}
            options={[
              { value: 'all', label: `${t('providers.statusAll')} (${counts.all})` },
              { value: 'configured', label: `${t('providers.statusConfigured')} (${counts.configured})` },
              { value: 'healthy', label: `${t('providers.statusHealthy')} (${counts.healthy})` },
              { value: 'issues', label: `${t('providers.statusIssues')} (${counts.issues})` },
              { value: 'unconfigured', label: `${t('providers.statusUnconfigured')} (${counts.unconfigured})` },
            ]}
            ariaLabel={t('providers.statusFilter')}
          />

          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5 cursor-pointer hover:text-foreground transition-colors">
              <input
                type="checkbox"
                checked={showHiddenProviders}
                onChange={(e) => setShowHiddenProviders(e.target.checked)}
                className="size-3.5 rounded border-input text-primary focus:ring-primary/40"
              />
              <span>{t('providers.showHiddenProviders')}</span>
            </label>

            <label className="flex items-center gap-1.5 cursor-pointer hover:text-foreground transition-colors">
              <input
                type="checkbox"
                checked={showHiddenModels}
                onChange={(e) => setShowHiddenModels(e.target.checked)}
                className="size-3.5 rounded border-input text-primary focus:ring-primary/40"
              />
              <span>{t('providers.showHiddenModels')}</span>
            </label>
          </div>
        </div>
      </div>

      {/* Provider List */}
      {filteredGrouped.length === 0 ? (
        <EmptyState
          icon={Server}
          title={t('providers.noProvidersFound')}
          description={t('providers.noProvidersDescription')}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearch('')
                setStatusFilter('all')
                setShowHiddenProviders(true)
              }}
            >
              {t('providers.resetFilters')}
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {filteredGrouped.map((group) => {
            const providerKey = group.endpointScope ? `${group.platform}:${group.endpointScope}` : group.platform
            const isCollapsed = collapsedProviders.has(providerKey)
            const isHidden = hiddenProviders.has(providerKey)

            return (
              <div
                key={providerKey}
                className={`overflow-hidden rounded-2xl border transition-all duration-200 ${
                  isHidden
                    ? 'border-dashed border-border/70 bg-card/30 opacity-75'
                    : 'border-border/80 bg-card/80 shadow-xs hover:border-border hover:shadow-md'
                }`}
              >
                {/* Header / Summary Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 p-4 select-none">
                  {/* Left: Icon + Title + Badges */}
                  <div
                    className="flex min-w-0 flex-1 items-center gap-3 cursor-pointer"
                    onClick={() => toggleCollapse(providerKey)}
                  >
                    {/* Expand Chevron */}
                    <button
                      type="button"
                      aria-label={isCollapsed ? t('providers.expand') : t('providers.collapse')}
                      className="p-1 text-muted-foreground/70 hover:text-foreground transition-colors rounded-lg"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                    </button>

                    {/* Provider Avatar / Icon */}
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-xs uppercase ring-1 ring-primary/20">
                      {group.platform.slice(0, 2)}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-heading text-base font-semibold text-foreground truncate">
                          {group.name}
                        </span>

                        {group.endpointScope && (
                          <span className="text-xs text-muted-foreground font-mono truncate max-w-50">
                            ({group.endpointScope})
                          </span>
                        )}

                        {group.url && (
                          <a
                            href={group.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-muted-foreground/60 hover:text-foreground transition-colors"
                            title={t('keys.getApiKey')}
                          >
                            <ExternalLink className="size-3.5" />
                          </a>
                        )}

                        {isHidden && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-muted-foreground/40 text-muted-foreground">
                            {t('providers.hidden')}
                          </Badge>
                        )}
                      </div>

                      {/* Status + Metrics Row */}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {/* Health status indicator */}
                        <div className="flex items-center gap-1.5 font-medium">
                          {group.summary.status === 'healthy' && (
                            <>
                              <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                              <span className="text-emerald-600 dark:text-emerald-400">{t('providers.statusHealthy')}</span>
                            </>
                          )}
                          {group.summary.status === 'issues' && (
                            <>
                              <span className="size-2 rounded-full bg-rose-500" />
                              <span className="text-rose-600 dark:text-rose-400">{t('providers.statusIssues')}</span>
                            </>
                          )}
                          {group.summary.status === 'rate_limited' && (
                            <>
                              <span className="size-2 rounded-full bg-amber-500" />
                              <span className="text-amber-600 dark:text-amber-400">{t('providers.statusRateLimited')}</span>
                            </>
                          )}
                          {group.summary.status === 'unknown' && (
                            <>
                              <span className="size-2 rounded-full bg-muted-foreground/50" />
                              <span>{t('providers.statusUnknown')}</span>
                            </>
                          )}
                          {group.summary.status === 'unconfigured' && (
                            <>
                              <span className="size-2 rounded-full bg-slate-400 dark:bg-slate-600" />
                              <span>{t('providers.statusUnconfigured')}</span>
                            </>
                          )}
                        </div>

                        <span>•</span>

                        {/* Keys count badge */}
                        <span className="tabular-nums">
                          {t('providers.keysSummary', {
                            count: group.summary.totalKeys,
                            enabled: group.summary.enabledKeys,
                          })}
                        </span>

                        <span>•</span>

                        {/* Models count badge */}
                        <span className="tabular-nums">
                          {t('providers.modelsSummary', {
                            count: group.summary.totalModels,
                            active: group.summary.activeModels,
                          })}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Right Header Actions */}
                  <div className="flex items-center gap-2">
                    {/* Add Key button */}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setAddKeyPlatform(group.platform as Platform)
                        setAddKeyOpen(true)
                      }}
                      title={t('providers.addKeyForProvider')}
                      className="text-xs"
                    >
                      <Plus className="size-3.5 mr-1" />
                      {t('providers.addKeyBtn')}
                    </Button>

                    {/* Add Model button */}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setAddModelPlatform(group.platform)
                        setAddModelOpen(true)
                      }}
                      title={t('providers.addModelForProvider')}
                      className="text-xs"
                    >
                      <Sparkles className="size-3.5 mr-1 text-primary" />
                      {t('providers.addModelBtn')}
                    </Button>

                    {/* Hide / Unhide Provider */}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => toggleHideProvider(providerKey)}
                      aria-label={isHidden ? t('providers.unhideProvider') : t('providers.hideProvider')}
                      title={isHidden ? t('providers.unhideProvider') : t('providers.hideProvider')}
                      className="text-muted-foreground/70 hover:text-foreground"
                    >
                      {isHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                    </Button>
                  </div>
                </div>

                {/* Expanded Content */}
                {!isCollapsed && (
                  <div className="border-t border-border/60 bg-muted/20 p-4 space-y-6">
                    {/* SUBSECTION 1: API KEYS */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <KeyRound className="size-4 text-muted-foreground" />
                          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {t('providers.keysSectionTitle')} ({group.keys.length})
                          </h4>
                        </div>

                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => {
                            setAddKeyPlatform(group.platform as Platform)
                            setAddKeyOpen(true)
                          }}
                          className="h-7 text-xs"
                        >
                          <Plus className="size-3 mr-1" />
                          {t('keys.addKey')}
                        </Button>
                      </div>

                      {group.keys.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-border/80 p-4 text-center">
                          <p className="text-xs text-muted-foreground mb-2">
                            {t('providers.noKeysConfigured')}
                          </p>
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setAddKeyPlatform(group.platform as Platform)
                              setAddKeyOpen(true)
                            }}
                          >
                            <Plus className="size-3.5 mr-1" />
                            {t('providers.addKeyBtn')}
                          </Button>
                        </div>
                      ) : (
                        <div className="divide-y divide-border/40 rounded-xl border border-border/70 bg-card overflow-hidden shadow-2xs">
                          {group.keys.map((k) => {
                            const isEditing = editingKeyId === k.id
                            const keyStatus = k.status ?? 'unknown'

                            return (
                              <div
                                key={k.id}
                                className="flex items-center justify-between gap-3 p-3 text-sm hover:bg-muted/30 transition-colors"
                              >
                                {/* Left: Key switch, label, masked key */}
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <Switch
                                    checked={Boolean(k.enabled)}
                                    onCheckedChange={(checked) =>
                                      toggleKeyMutation.mutate({ id: k.id, enabled: checked })
                                    }
                                    disabled={toggleKeyMutation.isPending}
                                  />

                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      {isEditing ? (
                                        <div className="flex items-center gap-1.5">
                                          <Input
                                            value={editingKeyLabel}
                                            onChange={(e) => setEditingKeyLabel(e.target.value)}
                                            className="h-7 text-xs w-48"
                                            autoFocus
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                updateKeyMutation.mutate({ id: k.id, label: editingKeyLabel })
                                              } else if (e.key === 'Escape') {
                                                setEditingKeyId(null)
                                              }
                                            }}
                                          />
                                          <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            onClick={() => updateKeyMutation.mutate({ id: k.id, label: editingKeyLabel })}
                                          >
                                            <Check className="size-3.5 text-emerald-500" />
                                          </Button>
                                          <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            onClick={() => setEditingKeyId(null)}
                                          >
                                            <X className="size-3.5" />
                                          </Button>
                                        </div>
                                      ) : (
                                        <span
                                          onClick={() => {
                                            setEditingKeyId(k.id)
                                            setEditingKeyLabel(k.label || '')
                                          }}
                                          className="font-medium text-foreground text-xs hover:underline cursor-pointer flex items-center gap-1"
                                          title={t('providers.clickToEditLabel')}
                                        >
                                          {k.label || t('providers.unlabeledKey')}
                                          <Pencil className="size-2.5 opacity-50" />
                                        </span>
                                      )}

                                      <span className="font-mono text-xs text-muted-foreground">
                                        {k.maskedKey}
                                      </span>
                                    </div>

                                    {/* Status & Last checked */}
                                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                                      <span className="flex items-center gap-1">
                                        <span
                                          className={`size-1.5 rounded-full ${
                                            statusDot[keyStatus] ?? statusDot.unknown
                                          }`}
                                        />
                                        <span>{statusLabelKey[keyStatus] ? t(statusLabelKey[keyStatus]) : keyStatus}</span>
                                      </span>

                                      {k.lastCheckedAt && (
                                        <>
                                          <span>•</span>
                                          <span>
                                            {t('providers.checked')} {formatSqliteUtcToLocalTime(k.lastCheckedAt)}
                                          </span>
                                        </>
                                      )}

                                      {k.lastHealthError && (
                                        <Tooltip text={k.lastHealthError}>
                                          <span className="text-rose-500 cursor-help flex items-center gap-0.5">
                                            <AlertCircle className="size-3" />
                                            {t('providers.healthIssue')}
                                          </span>
                                        </Tooltip>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Right: Key actions */}
                                <div className="flex items-center gap-1 shrink-0">
                                  {/* Copy Key */}
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => setCopyKey({ id: k.id, maskedKey: k.maskedKey })}
                                    title={t('keys.copyKey')}
                                    className="text-muted-foreground hover:text-foreground"
                                  >
                                    <Copy className="size-3.5" />
                                  </Button>

                                  {/* Check Health */}
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => checkKeyMutation.mutate(k.id)}
                                    disabled={checkKeyMutation.isPending}
                                    title={t('providers.recheckHealth')}
                                    className="text-muted-foreground hover:text-foreground"
                                  >
                                    <RefreshCw className={`size-3.5 ${checkKeyMutation.isPending ? 'animate-spin' : ''}`} />
                                  </Button>

                                  {/* Delete Key */}
                                  <ConfirmButton
                                    variant="ghost"
                                    size="icon-xs"
                                    armedSize="xs"
                                    className="text-muted-foreground hover:text-destructive shrink-0"
                                    confirmLabel={t('keys.confirmRemove')}
                                    onConfirm={() => deleteKeyMutation.mutate(k.id)}
                                    disabled={deleteKeyMutation.isPending}
                                    title={t('common.remove')}
                                    aria-label={t('common.remove')}
                                  >
                                    <Trash2 className="size-3" />
                                  </ConfirmButton>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {/* SUBSECTION 2: MODELS */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Layers className="size-4 text-muted-foreground" />
                          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {t('providers.modelsSectionTitle')} ({group.models.length})
                          </h4>
                        </div>

                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => {
                            setAddModelPlatform(group.platform)
                            setAddModelOpen(true)
                          }}
                          className="h-7 text-xs"
                        >
                          <Plus className="size-3 mr-1" />
                          {t('providers.addCustomModel')}
                        </Button>
                      </div>

                      {group.models.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-border/80 p-4 text-center">
                          <p className="text-xs text-muted-foreground mb-2">
                            {t('providers.noModelsConfigured')}
                          </p>
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setAddModelPlatform(group.platform)
                              setAddModelOpen(true)
                            }}
                          >
                            <Sparkles className="size-3.5 mr-1 text-primary" />
                            {t('providers.addCustomModel')}
                          </Button>
                        </div>
                      ) : (
                        <div className="divide-y divide-border/40 rounded-xl border border-border/70 bg-card overflow-hidden shadow-2xs">
                          {group.models.map((m) => {
                            const isModelHidden = hiddenModels.has(String(m.id))
                            const test = modelTests[m.id]

                            return (
                              <div
                                key={m.id}
                                className={`flex items-center justify-between gap-3 p-3 text-sm hover:bg-muted/30 transition-colors ${
                                  isModelHidden ? 'opacity-60 bg-muted/10' : ''
                                }`}
                              >
                                {/* Left: Enabled Switch + Model info */}
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <Switch
                                    checked={m.enabled}
                                    onCheckedChange={(checked) =>
                                      toggleModelMutation.mutate({ id: m.id, enabled: checked })
                                    }
                                    disabled={toggleModelMutation.isPending}
                                  />

                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium text-foreground text-xs truncate">
                                        {m.displayName || m.modelId}
                                      </span>

                                      <span className="font-mono text-[11px] text-muted-foreground">
                                        {m.modelId}
                                      </span>

                                      {/* Source Badge */}
                                      <Badge
                                        variant={m.source === 'custom' ? 'default' : 'secondary'}
                                        className={`text-[10px] px-1.5 py-0 h-4 ${
                                          m.source === 'custom'
                                            ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30'
                                            : ''
                                        }`}
                                      >
                                        {m.source === 'custom' ? t('providers.sourceCustom') : t('providers.sourceCatalog')}
                                      </Badge>

                                      {/* Capabilities Badges */}
                                      {m.supportsVision && (
                                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5 text-blue-600 dark:text-blue-400 border-blue-500/30">
                                          <Eye className="size-2.5" />
                                          {t('providers.vision')}
                                        </Badge>
                                      )}

                                      {m.supportsTools && (
                                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5 text-amber-600 dark:text-amber-400 border-amber-500/30">
                                          <Wrench className="size-2.5" />
                                          {t('providers.tools')}
                                        </Badge>
                                      )}

                                      {isModelHidden && (
                                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-muted-foreground/40 text-muted-foreground">
                                          {t('providers.hidden')}
                                        </Badge>
                                      )}
                                    </div>

                                    {/* Limits & Context details */}
                                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                      {m.contextWindow && (
                                        <span>
                                          {Math.round(m.contextWindow / 1024)}k {t('providers.contextShort')}
                                        </span>
                                      )}

                                      {m.rpmLimit && (
                                        <>
                                          <span>•</span>
                                          <span>{m.rpmLimit} RPM</span>
                                        </>
                                      )}

                                      {m.tpmLimit && (
                                        <>
                                          <span>•</span>
                                          <span>{Math.round(m.tpmLimit / 1000)}k TPM</span>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Right: Test + Hide + Delete controls */}
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {/* Test Result / Button */}
                                  {test?.result && (
                                    <div className="flex items-center gap-1">
                                      {test.result.success ? (
                                        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 text-[11px] gap-1 px-2 py-0.5">
                                          <Check className="size-3 text-emerald-500" />
                                          {t('providers.testPassedShort')} ({test.result.latencyMs}ms)
                                        </Badge>
                                      ) : (
                                        <Tooltip text={test.result.error || t('providers.testFailed')}>
                                          <Badge className="bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30 text-[11px] gap-1 px-2 py-0.5 cursor-help">
                                            <X className="size-3 text-rose-500" />
                                            {t('providers.testFailedShort')}
                                          </Badge>
                                        </Tooltip>
                                      )}
                                    </div>
                                  )}

                                  <Button
                                    variant="outline"
                                    size="xs"
                                    disabled={test?.loading}
                                    onClick={() => handleTestModel(m)}
                                    className="h-7 text-xs font-medium"
                                  >
                                    {test?.loading ? (
                                      <>
                                        <Loader2 className="size-3 mr-1 animate-spin" />
                                        {t('providers.testing')}
                                      </>
                                    ) : (
                                      <>
                                        <Zap className="size-3 mr-1 text-amber-500" />
                                        {t('providers.testBtn')}
                                      </>
                                    )}
                                  </Button>

                                  {/* Hide / Unhide Model */}
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => toggleHideModel(String(m.id))}
                                    aria-label={isModelHidden ? t('providers.unhideModel') : t('providers.hideModel')}
                                    title={isModelHidden ? t('providers.unhideModel') : t('providers.hideModel')}
                                    className="text-muted-foreground/70 hover:text-foreground"
                                  >
                                    {isModelHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                                  </Button>

                                  {/* Delete Model */}
                                  <ConfirmButton
                                    variant="ghost"
                                    size="icon-xs"
                                    armedSize="xs"
                                    className="text-muted-foreground hover:text-destructive shrink-0"
                                    confirmLabel={t('keys.confirmRemove')}
                                    onConfirm={() => deleteModelMutation.mutate(m.id)}
                                    disabled={deleteModelMutation.isPending}
                                    title={t('common.remove')}
                                    aria-label={t('common.remove')}
                                  >
                                    <Trash2 className="size-3" />
                                  </ConfirmButton>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Shared Dialogs */}
      <AddKeyDialog
        open={addKeyOpen}
        onOpenChange={setAddKeyOpen}
        initialPlatform={addKeyPlatform}
      />

      <AddModelDialog
        open={addModelOpen}
        onOpenChange={setAddModelOpen}
        initialPlatform={addModelPlatform}
      />

      {copyKey && (
        <CopyKeyDialog
          keyId={copyKey.id}
          maskedKey={copyKey.maskedKey}
          onOpenChange={(open) => {
            if (!open) setCopyKey(null)
          }}
        />
      )}
    </div>
  )
}
