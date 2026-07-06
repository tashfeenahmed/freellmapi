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
import { ChevronDown, ExternalLink, KeyRound, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { ApiKey, ApiKeyModel } from '../../../../shared/types'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useI18n } from '@/i18n'
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

type StatusFilter = 'all' | 'healthy' | 'issues' | 'disabled'

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

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
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

                {expanded && (
                  <div className="rounded-2xl border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const status = statusOf(k)
                      const lastChecked = healthKeyMap.get(k.id)?.lastCheckedAt
                      const isEditing = editingKeyId === k.id
                      const customModels = k.models ?? []
                      const hasCustomModels = customModels.length > 0
                      const isExpanded = expandedKeyIds.has(k.id)
                      const isChecking = checkKey.isPending && checkKey.variables === k.id
                      return (
                        <div key={k.id} className="bg-card">
                          <div className="group/krow flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
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
                            <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
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
                                {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                                {k.baseUrl && (
                                  <code className="text-[11px] text-muted-foreground font-mono truncate max-w-[260px]" title={k.baseUrl}>
                                    {k.baseUrl}
                                  </code>
                                )}
                              </>
                            )}
                            <span className="text-xs text-muted-foreground">{statusLabelKey[status] ? t(statusLabelKey[status]) : status}</span>
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
    </div>
  )
}
