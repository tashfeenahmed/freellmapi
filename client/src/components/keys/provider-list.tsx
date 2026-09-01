import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button, buttonVariants } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { EmptyState } from '@/components/empty-state'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu'
import { ChevronDown, CircleAlert, Copy, ExternalLink, KeyRound, ListFilter, ListPlus, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, Zap } from 'lucide-react'
import type { ApiKey, ApiKeyModel } from '../../../../shared/types'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import {
  PLATFORMS,
  CUSTOM_GROUP,
  CUSTOM_MODEL_KIND_LABEL,
  customModelDeleteKey,
  customModelDeletePath,
  statusDot,
  statusLabelKey,
} from './shared'
import type { HealthData } from './shared'
import { DiscoverModelsDialog } from './discover-models-dialog'
import { AddEndpointKeyDialog } from './add-endpoint-key-dialog'
import { CopyKeyDialog } from './copy-key-dialog'
import { ModelScopeDialog } from './model-scope-dialog'

type StatusFilter = 'all' | 'healthy' | 'issues' | 'disabled'

// #787: what the batch bar can do to the selected keys of one group.
type BulkAction = 'enable' | 'disable' | 'delete'

// The Providers tab body: a filter toolbar over a list of collapsible provider
// groups. Owns the keys/health/proxy queries and every per-key mutation so
// KeysPage stays a thin shell. `onAddKey` opens the shared Add key dialog.
export function ProviderList({ onAddKey }: { onAddKey: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [editingKeyId, setEditingKeyId] = useState<number | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [expandedKeyIds, setExpandedKeyIds] = useState<Set<number>>(new Set())
  // Explicit user open/closed overrides per provider group; absent = default.
  const [groupOverrides, setGroupOverrides] = useState<Map<string, boolean>>(new Map())
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  // Custom endpoint whose model list is being fetched (#488) — relays change
  // what they serve constantly, so this is a repeat action, not a one-off.
  const [discoverKeyId, setDiscoverKeyId] = useState<number | null>(null)
  // Custom endpoint taking another credential (#702). Keyed by base URL, since
  // a key joins the pool of an endpoint rather than of the row it was opened
  // from, and every key of that endpoint offers the same action.
  const [addKeyBaseUrl, setAddKeyBaseUrl] = useState<string | null>(null)
  // Key whose plaintext the operator asked to copy; re-authentication happens
  // in the dialog, not here (#705).
  const [copyKey, setCopyKey] = useState<{ id: number; maskedKey: string } | null>(null)
  // Key whose model scope is being edited (#657).
  const [scopeKeyId, setScopeKeyId] = useState<number | null>(null)
  // #787: keys selected for bulk enable/disable/delete within a group.
  const [selectedKeyIds, setSelectedKeyIds] = useState<Set<number>>(new Set())
  const editInputRef = useRef<HTMLInputElement>(null)

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const { data: proxyData } = useQuery<{ proxyUrl: string; enabled: boolean; bypassPlatforms: string[]; active: boolean }>({
    queryKey: ['proxy-url'],
    queryFn: () => apiFetch('/api/settings/proxy'),
  })
  const bypassPlatforms = proxyData?.bypassPlatforms ?? []
  const proxyEnabled = proxyData?.enabled ?? true

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      // Deleting the last key of a platform flips it back to unconfigured in
      // the checklist strip.
      queryClient.invalidateQueries({ queryKey: ['keys-providers'] })
    },
  })

  const deleteCustomModel = useMutation({
    mutationFn: (model: ApiKeyModel) => apiFetch(customModelDeletePath(model), { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['embeddings'] })
      queryClient.invalidateQueries({ queryKey: ['media'] })
    },
  })

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  // #685 follow-up: fire one real chat request at a custom endpoint so an
  // unmeasured model gains a reliability/speed sample immediately instead of
  // waiting for natural traffic. Only a successful probe records a sample.
  const probeKey = useMutation({
    // The global MutationCache toast would show the bare server message;
    // silence it and toast a translated line that carries the reason instead.
    meta: { silenceToast: true },
    mutationFn: (keyId: number) =>
      // reasoning/toolCalls are optional (#874): the server omits a capability
      // whose probe errored or timed out, and "absent" means UNKNOWN — which is
      // not the same claim as "the model cannot do it", so it renders as such.
      apiFetch<{ modelId: string; latencyMs: number; reasoning?: boolean; toolCalls?: boolean }>(`/api/keys/custom/probe`, {
        method: 'POST',
        body: JSON.stringify({ keyId }),
      }),
    onSuccess: (data) => {
      for (const key of ['keys', 'health', 'fallback']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      const capability = (value: boolean | undefined) =>
        value === undefined ? t('keys.probeCapUnknown') : value ? t('keys.probeCapYes') : t('keys.probeCapNo')
      const capabilities = t('keys.probeCapabilities', {
        reasoning: capability(data.reasoning),
        tools: capability(data.toolCalls),
      })
      toast.success(
        `${t('keys.probeSuccess', { model: data.modelId, latency: data.latencyMs })} — ${capabilities}`,
      )
    },
    onError: (error) => {
      toast.error(t('keys.probeFailed', { reason: error instanceof Error ? error.message : String(error) }))
    },
  })

  const togglePlatform = useMutation({
    mutationFn: ({ platform, enabled }: { platform: string; enabled: boolean }) =>
      apiFetch(`/api/keys/platform/${platform}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  // One key on or off, as opposed to togglePlatform's whole-platform sweep (#705).
  const setKeyEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  // #787: the batch bar's one mutation. There is no bulk endpoint, so this is
  // still one request per key against the per-key routes — but the outcome is
  // reported once. Per-key mutations would each raise the global error toast,
  // so a batch where key 3 of 8 failed left the user with a pile of unrelated
  // messages and no count. Here the global toast is silenced, the requests are
  // settled together, and a single summary carries how many landed and how many
  // did not.
  const bulkKeys = useMutation({
    meta: { silenceToast: true },
    mutationFn: async ({ ids, action }: { ids: number[]; action: BulkAction }) => {
      const results = await Promise.allSettled(ids.map(id =>
        action === 'delete'
          ? apiFetch(`/api/keys/${id}`, { method: 'DELETE' })
          : apiFetch(`/api/keys/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: action === 'enable' }),
          }),
      ))
      return {
        action,
        done: results.filter(r => r.status === 'fulfilled').length,
        failed: results.filter(r => r.status === 'rejected').length,
      }
    },
    onSuccess: ({ action, done, failed }) => {
      for (const key of ['keys', 'health', 'fallback']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      // Deleting the last key of a platform flips it back to unconfigured in
      // the checklist strip, same as the single-key delete above.
      if (action === 'delete') queryClient.invalidateQueries({ queryKey: ['keys-providers'] })
      const summary = action === 'delete'
        ? t('keys.bulkDeleteResult', { done, failed })
        : t('keys.bulkResult', { done, failed })
      if (failed > 0) toast.error(summary)
      else toast.success(summary)
    },
  })

  const updateKey = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) =>
      apiFetch(`/api/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      setEditingKeyId(null)
      setEditingLabel('')
    },
  })

  const toggleBypass = useMutation({
    mutationFn: (platform: string) => {
      const next = bypassPlatforms.includes(platform)
        ? bypassPlatforms.filter(p => p !== platform)
        : [...bypassPlatforms, platform]
      return apiFetch('/api/settings/proxy', { method: 'PUT', body: JSON.stringify({ bypassPlatforms: next }) })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['proxy-url'] }),
  })

  function startEditing(key: ApiKey) {
    setEditingKeyId(key.id)
    setEditingLabel(key.label)
  }

  function cancelEditing() {
    setEditingKeyId(null)
    setEditingLabel('')
  }

  function saveEditing(id: number) {
    if (editingLabel !== undefined) {
      updateKey.mutate({ id, label: editingLabel })
    }
  }

  function toggleExpandedKey(id: number) {
    setExpandedKeyIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    if (editingKeyId !== null && editInputRef.current) {
      editInputRef.current.focus()
    }
  }, [editingKeyId])

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null; lastHealthError: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)
  const statusOf = (k: ApiKey) => healthKeyMap.get(k.id)?.status ?? k.status

  const grouped = [...PLATFORMS, CUSTOM_GROUP].map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0)

  const totalProviders = grouped.length
  const totalKeys = grouped.reduce((n, g) => n + g.keys.length, 0)

  const q = search.trim().toLowerCase()

  function matchStatus(group: (typeof grouped)[number]): boolean {
    const enabled = group.keys.some(k => k.enabled)
    const hasIssue = group.keys.some(k => statusOf(k) !== 'healthy')
    switch (statusFilter) {
      case 'healthy': return enabled && !hasIssue
      case 'issues': return hasIssue
      case 'disabled': return !enabled
      default: return true
    }
  }

  // Search narrows either whole groups (label match) or the keys within them
  // (label / masked-key match); the status filter then trims the result set.
  const visibleGroups = grouped
    .map(group => {
      if (!q) return group
      if (group.label.toLowerCase().includes(q)) return group
      const matchingKeys = group.keys.filter(k =>
        (k.label ?? '').toLowerCase().includes(q) ||
        (k.maskedKey ?? '').toLowerCase().includes(q),
      )
      return { ...group, keys: matchingKeys }
    })
    .filter(group => group.keys.length > 0 && matchStatus(group))

  function isGroupExpanded(group: (typeof grouped)[number]): boolean {
    if (q) return true // an active search auto-expands every matching group
    const override = groupOverrides.get(group.value)
    if (override !== undefined) return override
    const hasIssue = group.keys.some(k => statusOf(k) !== 'healthy')
    return hasIssue || grouped.length <= 3
  }

  function toggleGroup(value: string, expanded: boolean) {
    setGroupOverrides(prev => {
      const next = new Map(prev)
      next.set(value, !expanded)
      return next
    })
  }

  if (isLoading) return <TableSkeleton rows={4} />

  if (keys.length === 0) {
    return (
      <EmptyState
        icon={KeyRound}
        title={t('keys.noProviderKeys')}
        action={
          <Button size="sm" onClick={onAddKey}>
            <Plus className="size-3.5" />
            {t('keys.addKey')}
          </Button>
        }
      />
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('keys.filterPlaceholder')}
            className="h-8 pl-8"
          />
        </div>
        <SegmentedControl
          value={statusFilter}
          onValueChange={setStatusFilter}
          options={[
            { value: 'all', label: t('keys.filterAll') },
            { value: 'healthy', label: t('keys.filterHealthy') },
            { value: 'issues', label: t('keys.filterIssues') },
            { value: 'disabled', label: t('keys.filterDisabled') },
          ]}
          ariaLabel={t('keys.filterAll')}
        />
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('keys.providerCountSummary', { providers: totalProviders, keys: totalKeys })}
        </span>
      </div>

      {visibleGroups.length === 0 ? (
        <EmptyState title={t('keys.noFilterMatch')} />
      ) : (
        <div className="space-y-4">
          {visibleGroups.map(group => {
            const expanded = isGroupExpanded(group)
            const healthyCount = group.keys.filter(k => statusOf(k) === 'healthy').length
            const issueCount = group.keys.filter(k => statusOf(k) !== 'healthy').length
            // #787: once a selection exists in this group the checkboxes stay
            // visible, so the rest of the selection can be built without hunting.
            const groupHasSelection = group.keys.some(k => selectedKeyIds.has(k.id))
            return (
              <div key={group.value}>
                <div className="flex items-center gap-2 pb-2">
                  <Switch
                    checked={group.keys.some(k => k.enabled)}
                    onCheckedChange={(checked) =>
                      togglePlatform.mutate({ platform: group.value, enabled: checked })
                    }
                    disabled={togglePlatform.isPending}
                  />
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.value, expanded)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={expanded}
                  >
                    <h3 className="text-sm font-medium">{group.label}</h3>
                    <Badge variant="secondary" className="tabular-nums">{group.keys.length}</Badge>
                    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      {healthyCount > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <span className="size-1.5 rounded-full bg-emerald-500" />
                          {t('keys.summaryHealthy', { count: healthyCount })}
                        </span>
                      )}
                      {issueCount > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <span className="size-1.5 rounded-full bg-rose-500" />
                          {t(issueCount === 1 ? 'keys.summaryIssueOne' : 'keys.summaryIssueOther', { count: issueCount })}
                        </span>
                      )}
                    </span>
                  </button>
                  {(group.url || proxyEnabled) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
                        aria-label={t('keys.providerActions')}
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        {group.url && (
                          <DropdownMenuItem onClick={() => window.open(group.url, '_blank', 'noopener,noreferrer')}>
                            {t('keys.getApiKey')}
                            <ExternalLink className="ml-auto size-3.5" />
                          </DropdownMenuItem>
                        )}
                        {proxyEnabled && (
                          <DropdownMenuCheckboxItem
                            checked={!bypassPlatforms.includes(group.value)}
                            onCheckedChange={() => toggleBypass.mutate(group.value)}
                            closeOnClick={false}
                          >
                            {t('keys.routeViaProxy')}
                          </DropdownMenuCheckboxItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.value, expanded)}
                    aria-label={expanded ? t('common.hide') : t('common.show')}
                    className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
                  >
                    <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`} />
                  </button>
                </div>

                {/* #787: batch bar — appears only while keys of THIS group are
                    selected. One mutation per key (the per-key endpoint), which
                    keeps the router and health caches consistent. */}
                {(() => {
                  const groupSelected = group.keys.filter(k => selectedKeyIds.has(k.id))
                  if (groupSelected.length === 0) return null
                  const clearGroup = () => setSelectedKeyIds(prev => {
                    const next = new Set(prev)
                    groupSelected.forEach(k => next.delete(k.id))
                    return next
                  })
                  const bulk = (action: BulkAction) => {
                    bulkKeys.mutate({ ids: groupSelected.map(k => k.id), action })
                    clearGroup()
                  }
                  return (
                    <div className="mb-2 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-xs">
                      <span className="text-muted-foreground">{t('keys.bulkSelected', { count: groupSelected.length })}</span>
                      <Button size="xs" variant="outline" disabled={bulkKeys.isPending} onClick={() => bulk('enable')}>
                        {t('keys.bulkEnable')}
                      </Button>
                      <Button size="xs" variant="outline" disabled={bulkKeys.isPending} onClick={() => bulk('disable')}>
                        {t('keys.bulkDisable')}
                      </Button>
                      {/* Delete takes the dashboard's arm-then-fire idiom, same as the
                          per-key Remove below; the armed label names the count, since
                          one misclick here would take out the whole selection. */}
                      <ConfirmButton
                        variant="outline"
                        size="xs"
                        className="text-muted-foreground hover:text-destructive"
                        confirmLabel={t('keys.bulkDeleteConfirm', { count: groupSelected.length })}
                        onConfirm={() => bulk('delete')}
                        disabled={bulkKeys.isPending}
                      >
                        {t('keys.bulkDelete')}
                      </ConfirmButton>
                      <Button size="xs" variant="ghost" onClick={clearGroup}>
                        {t('common.dismiss')}
                      </Button>
                    </div>
                  )
                })()}

                {expanded && (
                  <div className="rounded-2xl border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const status = statusOf(k)
                      const health = healthKeyMap.get(k.id)
                      const lastChecked = health?.lastCheckedAt ?? k.lastCheckedAt
                      const lastHealthError = health?.lastHealthError ?? k.lastHealthError
                      const isEditing = editingKeyId === k.id
                      const customModels = k.models ?? []
                      const hasCustomModels = customModels.length > 0
                      const isExpanded = expandedKeyIds.has(k.id)
                      const isChecking = checkKey.isPending && checkKey.variables === k.id
                      return (
                        <div key={k.id} className="bg-card">
                          <div className="group/krow flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                            {/* #787: bulk-select checkbox — enabling the row-level
                                batch bar below. Deliberately secondary: the switch
                                stays the primary per-key control, and a checkbox on
                                every row at rest is chrome nobody asked for. It fades
                                in on row hover, on keyboard focus, and for as long as
                                the group holds a selection. Opacity, not display: the
                                box keeps its width either way, so nothing in the row
                                shifts when it appears. */}
                            <input
                              type="checkbox"
                              checked={selectedKeyIds.has(k.id)}
                              onChange={(e) => {
                                setSelectedKeyIds(prev => {
                                  const next = new Set(prev)
                                  if (e.target.checked) next.add(k.id)
                                  else next.delete(k.id)
                                  return next
                                })
                              }}
                              aria-label={t('keys.selectKey')}
                              className={`size-3.5 flex-shrink-0 accent-foreground cursor-pointer transition-opacity focus-visible:opacity-100 ${groupHasSelection ? 'opacity-100' : 'opacity-0 group-hover/krow:opacity-100'}`}
                            />
                            {/* Per-key switch (#705). The group switch writes every key of the
                                platform at once, which for the Custom group meant every endpoint
                                you run. The API has taken a per-key `enabled` all along and the
                                router honours it; only the dashboard could not say it. Leading,
                                like the group's own switch, so the hierarchy reads at a glance
                                and a disabled key is visible without hovering the row. */}
                            <Switch
                              size="sm"
                              checked={k.enabled}
                              onCheckedChange={(checked) => setKeyEnabled.mutate({ id: k.id, enabled: checked })}
                              disabled={setKeyEnabled.isPending && setKeyEnabled.variables?.id === k.id}
                              aria-label={t('keys.enable')}
                            />
                            <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                            {hasCustomModels && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className="size-6 p-0 text-muted-foreground"
                                onClick={() => toggleExpandedKey(k.id)}
                                title={isExpanded ? t('common.hide') : t('common.show')}
                              >
                                <ChevronDown className={`size-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                              </Button>
                            )}
                            <code className={`text-xs font-mono flex-shrink-0 ${k.enabled ? '' : 'opacity-50'}`}>{k.maskedKey}</code>
                            {isEditing ? (
                              <Input
                                ref={editInputRef}
                                value={editingLabel}
                                onChange={e => setEditingLabel(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveEditing(k.id)
                                  if (e.key === 'Escape') cancelEditing()
                                }}
                                onBlur={() => saveEditing(k.id)}
                                className="h-6 w-[160px] text-xs"
                                disabled={updateKey.isPending}
                              />
                            ) : (
                              <>
                                {/* The label is the edit affordance itself (#705): the pencil
                                    only appears on hover, so clicking the name is the move
                                    everyone tries first. An unlabelled key still needs
                                    somewhere to click, hence the muted prompt. */}
                                <button
                                  type="button"
                                  onClick={() => startEditing(k)}
                                  title={t('keys.editLabel')}
                                  className={`rounded text-xs hover:text-foreground hover:underline underline-offset-2 ${k.label ? 'text-muted-foreground' : 'text-muted-foreground/50'} ${k.enabled ? '' : 'opacity-50'}`}
                                >
                                  {k.label || t('keys.editLabel')}
                                </button>
                                {k.baseUrl && (
                                  <code className={`text-[11px] text-muted-foreground font-mono truncate max-w-[260px] ${k.enabled ? '' : 'opacity-50'}`} title={k.baseUrl}>
                                    {k.baseUrl}
                                  </code>
                                )}
                              </>
                            )}
                            <span className={`text-xs text-muted-foreground ${k.enabled ? '' : 'opacity-50'}`}>{statusLabelKey[status] ? t(statusLabelKey[status]) : status}</span>
                            {/* Only a SCOPED key shows anything (#657); an unscoped one stays as it always was. */}
                            {(k.modelScope?.length ?? 0) > 0 && (
                              <Badge
                                variant="secondary"
                                className={`text-[10px] text-muted-foreground ${k.enabled ? '' : 'opacity-50'}`}
                                title={k.modelScope!.join(', ')}
                              >
                                {t(k.modelScope!.length === 1 ? 'keys.modelScopeBadgeOne' : 'keys.modelScopeBadgeOther', { count: k.modelScope!.length })}
                              </Badge>
                            )}
                            <div className="flex-1" />
                            {lastChecked && (
                              <span className="text-[11px] text-muted-foreground tabular-nums">
                                {formatSqliteUtcToLocalTime(lastChecked, { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            )}
                            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/krow:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                              {!isEditing && (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() => startEditing(k)}
                                  aria-label={t('keys.editLabel')}
                                  title={t('keys.editLabel')}
                                >
                                  <Pencil className="size-3" />
                                </Button>
                              )}
                              {!k.keyless && (
                                <Tooltip text={t('keys.copyFullKey')}>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => setCopyKey({ id: k.id, maskedKey: k.maskedKey })}
                                    aria-label={t('keys.copyFullKey')}
                                  >
                                    <Copy className="size-3" />
                                  </Button>
                                </Tooltip>
                              )}
                              {k.platform === 'custom' && k.baseUrl && (
                                <>
                                  <Tooltip text={t('keys.addKey')}>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() => setAddKeyBaseUrl(k.baseUrl!)}
                                      aria-label={t('keys.addKey')}
                                    >
                                      <KeyRound className="size-3" />
                                    </Button>
                                  </Tooltip>
                                  <Tooltip text={t('keys.discoverModels')}>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() => setDiscoverKeyId(k.id)}
                                      aria-label={t('keys.discoverModels')}
                                    >
                                      <ListPlus className="size-3" />
                                    </Button>
                                  </Tooltip>
                                  <Tooltip text={t('keys.probeNow')}>
                                    <ConfirmButton
                                      variant="ghost"
                                      size="icon-xs"
                                      armedSize="xs"
                                      confirmLabel={t('keys.probeConfirm')}
                                      onConfirm={() => probeKey.mutate(k.id)}
                                      disabled={probeKey.isPending}
                                      title={t('keys.probeNow')}
                                      aria-label={t('keys.probeNow')}
                                    >
                                      <Zap className={`size-3 ${probeKey.isPending ? 'animate-pulse' : ''}`} />
                                    </ConfirmButton>
                                  </Tooltip>
                                </>
                              )}
                              {/* Deliberately secondary (#657): a small hover-cluster affordance,
                                  not a first-fold control. */}
                              {!k.keyless && (
                                <Tooltip text={t('keys.modelScope')}>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => setScopeKeyId(k.id)}
                                    aria-label={t('keys.modelScope')}
                                  >
                                    <ListFilter className="size-3" />
                                  </Button>
                                </Tooltip>
                              )}
                              <Tooltip text={t('keys.checkNow')}>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() => checkKey.mutate(k.id)}
                                  disabled={checkKey.isPending}
                                  aria-label={t('keys.checkNow')}
                                >
                                  <RefreshCw className={`size-3 ${isChecking ? 'animate-spin' : ''}`} />
                                </Button>
                              </Tooltip>
                              <ConfirmButton
                                variant="ghost"
                                size="icon-xs"
                                armedSize="xs"
                                className="text-muted-foreground hover:text-destructive"
                                confirmLabel={t('keys.confirmRemove')}
                                onConfirm={() => deleteKey.mutate(k.id)}
                                disabled={deleteKey.isPending}
                                title={t('common.remove')}
                                aria-label={t('common.remove')}
                              >
                                <Trash2 className="size-3" />
                              </ConfirmButton>
                            </div>
                          </div>
                          {lastHealthError && (
                            <div className="flex items-start gap-2 px-4 pb-3 pl-8 text-xs text-destructive" role="status">
                              <CircleAlert className="mt-0.5 size-3.5 flex-shrink-0" />
                              <span className="break-words" title={lastHealthError}>{lastHealthError}</span>
                            </div>
                          )}
                          {hasCustomModels && isExpanded && (
                            <div className="flex flex-wrap gap-2 border-t bg-muted/20 px-4 py-3 pl-12">
                              {customModels.map(model => {
                                const modelKey = customModelDeleteKey(model)
                                return (
                                  <div key={modelKey} className="inline-flex min-w-0 items-center gap-2 rounded-md border bg-background px-2 py-1 text-[11px]">
                                    <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      {t(CUSTOM_MODEL_KIND_LABEL[model.kind])}
                                    </span>
                                    <span className="max-w-[180px] truncate font-medium" title={model.modelId}>
                                      {model.displayName}
                                    </span>
                                    {model.family && (
                                      <code className="max-w-[160px] truncate text-muted-foreground" title={model.family}>
                                        {model.family}
                                      </code>
                                    )}
                                    <ConfirmButton
                                      className="h-5 px-1 text-muted-foreground hover:text-destructive"
                                      disabled={deleteCustomModel.isPending}
                                      onConfirm={() => deleteCustomModel.mutate(model)}
                                      title={t('common.remove')}
                                      aria-label={t('common.remove')}
                                    >
                                      <Trash2 className="size-3" />
                                    </ConfirmButton>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {discoverKeyId !== null && (
        <DiscoverModelsDialog
          open
          onOpenChange={(open) => { if (!open) setDiscoverKeyId(null) }}
          endpoint={{ keyId: discoverKeyId }}
        />
      )}

      {addKeyBaseUrl !== null && (
        <AddEndpointKeyDialog
          open
          onOpenChange={(open) => { if (!open) setAddKeyBaseUrl(null) }}
          baseUrl={addKeyBaseUrl}
        />
      )}

      {copyKey !== null && (
        <CopyKeyDialog
          keyId={copyKey.id}
          maskedKey={copyKey.maskedKey}
          onOpenChange={(open) => { if (!open) setCopyKey(null) }}
        />
      )}

      {(() => {
        // Resolved from the live query so a save re-seeds the next open (#657).
        const scopeKey = scopeKeyId !== null ? keys.find(k => k.id === scopeKeyId) : undefined
        return scopeKey ? (
          <ModelScopeDialog
            apiKey={scopeKey}
            onOpenChange={(open) => { if (!open) setScopeKeyId(null) }}
          />
        ) : null
      })()}
    </div>
  )
}
