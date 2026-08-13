import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, Pencil, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import { apiFetch, getToken } from '@/lib/api'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { FieldError } from '@/components/ui/field-error'
import { CardSkeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogClose, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { PLATFORMS, statusDot, statusLabelKey } from '@/components/keys/shared'
import { usePremium } from '@/hooks/use-premium'
import { isHttpUrl } from '@/lib/validate'
import type { ApiKey, Platform } from '../../../shared/types'

type Tab = 'license' | 'models' | 'backup'

interface ConfigModel {
  id: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  deprecated: boolean
  supportsVision: boolean
  supportsTools: boolean
  contextWindow: number | null
  source: 'catalog' | 'custom'
}

interface BackupMeta {
  id: number
  filename: string
  filesize: number
  isFull: boolean
  source: 'manual' | 'scheduled'
  createdAt: string
  tables: string[]
}

interface BackupSchedule {
  enabled: boolean
  time: string
  intervalDays: number
  backupPath: string
}

function fmtWhen(ms: number | null): string | null {
  if (!ms) return null
  return new Date(ms).toLocaleString()
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function downloadBackupFile(id: number, filename: string): Promise<void> {
  const token = getToken()
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  const res = await fetch(`${base}/api/backups/${id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    toast.error(body?.error?.message ?? `HTTP ${res.status}`)
    return
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function parseModelList(raw: string): string[] {
  const seen = new Set<string>()
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && seen.add(s))
}

function platformLabel(platform: string): string {
  return PLATFORMS.find((p) => p.value === platform)?.label ?? platform
}

export default function ConfigPage() {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('license')

  const tabs: { value: Tab; label: string }[] = [
    { value: 'license', label: t('config.tabs.license') },
    { value: 'models', label: t('config.tabs.models') },
    { value: 'backup', label: t('config.tabs.backup') },
  ]

  return (
    <div>
      <PageHeader title={t('config.title')} description={t('config.description')} />

      <SegmentedControl value={tab} onValueChange={setTab} options={tabs} ariaLabel={t('config.title')} className="mb-6" />

      {tab === 'license' && <LicenseTab />}
      {tab === 'models' && <ModelsTab />}
      {tab === 'backup' && <BackupTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* License & sync tab (moved from the former Premium page)            */
/* ------------------------------------------------------------------ */

function LicenseTab() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [keyInput, setKeyInput] = useState('')
  const [activateAttempted, setActivateAttempted] = useState(false)

  const { data, isLoading, licensed } = usePremium()

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['premium'] })
    // A sync may have changed the model list and quirks.
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }

  const activate = useMutation({
    meta: { silenceToast: true },
    mutationFn: (key: string) =>
      apiFetch('/api/premium/key', { method: 'POST', body: JSON.stringify({ key }) }),
    onSuccess: () => {
      setKeyInput('')
      invalidate()
    },
  })

  const removeKey = useMutation({
    mutationFn: () => apiFetch('/api/premium/key', { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  const syncNow = useMutation({
    mutationFn: () => apiFetch('/api/premium/sync', { method: 'POST' }),
    onSuccess: invalidate,
  })

  const openPortal = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => apiFetch<{ url: string }>('/api/premium/portal', { method: 'POST' }),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener')
    },
  })

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    )
  }

  const { hasKey, maskedKey, license, catalog, siteUrl } = data
  const live = catalog.appliedTier === 'live'

  return (
    <div>
      <div className="flex justify-end mb-4">
        <Button variant="outline" size="sm" onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
          <RefreshCw className={syncNow.isPending ? 'animate-spin' : ''} />
          {syncNow.isPending ? t('premium.syncing') : t('premium.checkForUpdates')}
        </Button>
      </div>

      <div className="space-y-8">
        <section>
          <h2 className="text-sm font-medium mb-3">{t('premium.catalogFeed')}</h2>
          <div className="rounded-3xl border bg-card p-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <span className={`inline-block size-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                <span className="text-sm font-medium">{live ? t('premium.liveFeed') : t('premium.monthlySnapshot')}</span>
                <Badge variant="outline" className="font-mono text-[11px]">
                  {catalog.appliedVersion ?? t('premium.bundled')}
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">{t('premium.lastChecked', { when: fmtWhen(catalog.lastSyncMs) ?? t('common.never') })}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              {live ? t('premium.liveDescription') : t('premium.snapshotDescription')}
            </p>
            {catalog.lastError && (
              <p className="text-destructive text-xs mt-2">{t('premium.lastSyncProblem', { error: catalog.lastError })}</p>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium mb-3">{t('premium.license')}</h2>
          {hasKey ? (
            <div className="rounded-3xl border bg-card p-5 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm">{maskedKey}</span>
                {licensed ? (
                  <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent">
                    {license?.plan === 'annual'
                      ? t('premium.planAnnual')
                      : license?.plan === 'lifetime'
                        ? t('premium.planLifetime')
                        : t('premium.planGeneric')}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-destructive border-destructive/40">
                    {license?.reason === 'expired' ? t('premium.expired') : t('premium.inactive')}
                  </Badge>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {licensed && license?.plan === 'lifetime' && t('premium.lifetimeNote')}
                {licensed && license?.plan === 'annual' && !license.cancelAtPeriodEnd && license.expiresAt &&
                  t('premium.renewsOn', { date: fmtDate(license.expiresAt) })}
                {licensed && license?.plan === 'annual' && license.cancelAtPeriodEnd && license.expiresAt &&
                  t('premium.willNotRenew', { date: fmtDate(license.expiresAt) })}
                {!licensed && t('premium.keyInactive')}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => openPortal.mutate()} disabled={openPortal.isPending}>
                  <ExternalLink />
                  {openPortal.isPending ? t('premium.openingPortal') : t('premium.manageSubscription')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeKey.mutate()}
                  disabled={removeKey.isPending}
                  className="text-muted-foreground"
                >
                  {t('premium.removeKey')}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">{t('premium.manageHint')}</p>
              {openPortal.isError && (
                <p className="text-destructive text-xs">{(openPortal.error as Error).message}</p>
              )}
            </div>
          ) : (
            <div className="rounded-3xl border bg-card p-5 space-y-4">
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!keyInput.trim()) {
                    setActivateAttempted(true)
                    return
                  }
                  setActivateAttempted(false)
                  activate.mutate(keyInput.trim())
                }}
              >
                <div className="space-y-1.5 flex-1 min-w-[260px]">
                  <Label className="text-xs">{t('premium.licenseKey')}</Label>
                  <Input
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="fla_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                    className="font-mono text-xs"
                    autoComplete="off"
                    aria-invalid={activateAttempted && !keyInput.trim()}
                  />
                  {activateAttempted && !keyInput.trim() && <FieldError error={t('validation.required')} />}
                </div>
                <Button type="submit" size="sm" disabled={activate.isPending}>
                  {activate.isPending ? t('premium.activating') : t('premium.activate')}
                </Button>
              </form>
              {activate.isError && (
                <p className="text-destructive text-xs">{(activate.error as Error).message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('premium.keyHint')}{' '}
                <a className="underline hover:text-foreground" href={`${siteUrl}/manage.html`} target="_blank" rel="noopener noreferrer">
                  {t('premium.recoverKey')}
                </a>
                .
              </p>
            </div>
          )}
        </section>

        {!licensed && (
          <section>
            <div className="rounded-3xl border bg-card p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <Sparkles className="size-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{t('premium.upsellTitle')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('premium.upsellDescription')}</p>
                </div>
              </div>
              <a href={`${siteUrl}/#pricing`} target="_blank" rel="noopener noreferrer" className="shrink-0">
                <Button size="sm">
                  {t('premium.goPremium')}
                  <ExternalLink />
                </Button>
              </a>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Models management tab: providers + model list                      */
/* ------------------------------------------------------------------ */

function ModelsTab() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: keys = [], isLoading: keysLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: models = [], isLoading: modelsLoading } = useQuery<ConfigModel[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['keys'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
    queryClient.invalidateQueries({ queryKey: ['health'] })
    queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  const setKeyEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: invalidateAll,
  })

  const setModel = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, unknown> }) =>
      apiFetch(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const deleteModel = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const syncModels = useMutation({
    meta: { silenceToast: true },
    mutationFn: () =>
      apiFetch<{ sync: { action: string; counts?: { inserted: number; updated: number; removed: number } } }>('/api/models/sync', { method: 'POST' }),
    onSuccess: ({ sync }) => {
      const counts = sync.counts ?? { inserted: 0, updated: 0, removed: 0 }
      const { inserted, updated, removed } = counts
      if (sync.action === 'up_to_date' || inserted + updated + removed === 0) {
        toast.info(t('config.models.syncNoChanges'))
      } else {
        toast.success(t('config.models.syncResult', { added: inserted, updated, removed }))
      }
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  })

  if (keysLoading || modelsLoading) {
    return (
      <div className="space-y-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    )
  }

  const customKeys = keys.filter((k) => k.platform === 'custom')
  const enabledKeys = keys.filter((k) => k.enabled).length
  const enabledModels = models.filter((m) => m.enabled).length
  const deprecatedModels = models.filter((m) => m.deprecated).length

  return (
    <div className="space-y-8">
      {/* Providers */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="text-sm font-medium">{t('config.providers.heading')}</h2>
          <div className="flex items-center gap-2">
            <AddStandardPlatformDialog onAdded={invalidateAll} />
            <AddCustomProviderDialog onAdded={invalidateAll} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          {t('config.providers.summary', { total: keys.length, enabled: enabledKeys, custom: customKeys.length })}
        </p>

        {keys.length === 0 ? (
          <div className="rounded-3xl border bg-card p-8 text-center">
            <p className="text-sm font-medium">{t('config.providers.empty')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('config.providers.emptyHint')}</p>
          </div>
        ) : (
          <div className="rounded-3xl border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('config.providers.platform')}</TableHead>
                  <TableHead>{t('config.providers.label')}</TableHead>
                  <TableHead>{t('config.providers.apiKey')}</TableHead>
                  <TableHead>{t('config.providers.baseUrl')}</TableHead>
                  <TableHead>{t('config.providers.status')}</TableHead>
                  <TableHead>{t('config.providers.enabled')}</TableHead>
                  <TableHead className="text-right">{t('config.providers.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>
                      {key.platform === 'custom' ? (
                        <Badge variant="outline">{t('config.providers.custom')}</Badge>
                      ) : (
                        <span className="text-sm">{platformLabel(key.platform)}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{key.label || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{key.maskedKey || '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{key.baseUrl ?? '—'}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={`inline-block size-2 rounded-full ${statusDot[key.status] ?? statusDot.unknown}`} />
                        {t(statusLabelKey[key.status] ?? statusLabelKey.unknown)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Switch
                        size="sm"
                        checked={key.enabled}
                        onCheckedChange={(enabled) => setKeyEnabled.mutate({ id: key.id, enabled })}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-1">
                        {key.platform !== 'custom' && (
                          <AddModelDialog
                            models={models}
                            defaultPlatform={key.platform as Platform}
                            onAdded={invalidateAll}
                          />
                        )}
                        <EditProviderDialog keyRow={key} onSaved={invalidateAll} />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={t('config.providers.deleteProvider')}
                          onClick={() => {
                            if (window.confirm(t('config.providers.confirmDeleteProvider'))) deleteKey.mutate(key.id)
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* Models */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="text-sm font-medium">{t('config.models.heading')}</h2>
          <div className="flex items-center gap-2">
            <AddModelDialog models={models} trigger="text" onAdded={invalidateAll} />
            <Button variant="outline" size="sm" onClick={() => syncModels.mutate()} disabled={syncModels.isPending}>
              <RefreshCw className={syncModels.isPending ? 'animate-spin' : ''} />
              {t('config.models.syncModels')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          {t('config.models.summary', { total: models.length, enabled: enabledModels, deprecated: deprecatedModels })}
        </p>

        {models.length === 0 ? (
          <div className="rounded-3xl border bg-card p-8 text-center text-sm text-muted-foreground">
            {t('config.providers.empty')}
          </div>
        ) : (
          <div className="rounded-3xl border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('config.models.model')}</TableHead>
                  <TableHead>{t('config.models.source')}</TableHead>
                  <TableHead>{t('config.providers.enabled')}</TableHead>
                  <TableHead>{t('config.models.deprecated')}</TableHead>
                  <TableHead>{t('config.models.vision')}</TableHead>
                  <TableHead>{t('config.models.tools')}</TableHead>
                  <TableHead className="text-right">{t('config.providers.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((model) => (
                  <TableRow key={model.id}>
                    <TableCell>
                      <div className="text-sm">{model.displayName || model.modelId}</div>
                      <div className="font-mono text-xs text-muted-foreground">{model.modelId}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={model.source === 'catalog' ? 'outline' : 'secondary'}>
                        {model.source === 'catalog' ? t('config.models.catalog') : t('config.models.custom')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Switch
                        size="sm"
                        checked={model.enabled}
                        onCheckedChange={(enabled) => setModel.mutate({ id: model.id, patch: { enabled } })}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        size="sm"
                        checked={model.deprecated}
                        onCheckedChange={(deprecated) => setModel.mutate({ id: model.id, patch: { deprecated } })}
                      />
                    </TableCell>
                    <TableCell>{model.supportsVision ? '✓' : '—'}</TableCell>
                    <TableCell>{model.supportsTools ? '✓' : '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          if (window.confirm(t('config.models.confirmDeleteModel'))) deleteModel.mutate(model.id)
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-3">{t('config.models.hint')}</p>
      </section>
    </div>
  )
}

function AddStandardPlatformDialog({ onAdded }: { onAdded: () => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [platform, setPlatform] = useState<Platform>(PLATFORMS[0].value)
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [attempted, setAttempted] = useState(false)

  const add = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      toast.success(t('keys.keyAdded'))
      setOpen(false)
      setKey('')
      setLabel('')
      setAttempted(false)
      onAdded()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  })

  const keyless = PLATFORMS.find((p) => p.value === platform)?.keyless ?? false

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('config.providers.addStandard')}
      </Button>
      <DialogPopup maxWidth="max-w-md">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('config.providers.addStandard')}</DialogTitle>
          <DialogClose className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground">
            <X className="size-4" />
          </DialogClose>
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!key.trim() && !keyless) {
              setAttempted(true)
              return
            }
            setAttempted(false)
            add.mutate({ platform, key: key.trim(), label: label.trim() || undefined })
          }}
        >
          <div className="space-y-2">
            <Label className="text-xs">{t('config.providers.platform')}</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.providers.apiKey')}</Label>
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={keyless ? t('keys.noKeyNeededPlaceholder') : 'sk-…'}
              aria-invalid={attempted && !key.trim() && !keyless}
            />
            {attempted && !key.trim() && !keyless && <FieldError error={t('validation.required')} />}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.providers.label')}</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('config.providers.editLabelPlaceholder')} />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <DialogClose render={<Button type="button" variant="ghost" size="sm">{t('config.providers.cancel')}</Button>} />
            <Button type="submit" size="sm" disabled={add.isPending}>
              {add.isPending ? t('config.models.adding') : t('config.models.add')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function AddCustomProviderDialog({ onAdded }: { onAdded: () => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [modelIds, setModelIds] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('')
  const [attempted, setAttempted] = useState(false)

  const add = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/keys/custom', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      toast.success(t('keys.modelAdded'))
      setOpen(false)
      setBaseUrl('')
      setModelIds('')
      setApiKey('')
      setLabel('')
      setAttempted(false)
      onAdded()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  })

  const models = parseModelList(modelIds)
  const baseUrlError = !baseUrl.trim() ? t('validation.required') : !isHttpUrl(baseUrl) ? t('validation.url') : null
  const modelsError = models.length === 0 ? t('validation.required') : null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('config.providers.addCustom')}
      </Button>
      <DialogPopup maxWidth="max-w-md">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('config.models.addCustomTitle')}</DialogTitle>
          <DialogClose className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground">
            <X className="size-4" />
          </DialogClose>
        </div>
        <DialogDescription className="mb-4">{t('config.models.addCustomHint')}</DialogDescription>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (baseUrlError || modelsError) {
              setAttempted(true)
              return
            }
            setAttempted(false)
            add.mutate({
              baseUrl: baseUrl.trim(),
              models,
              apiKey: apiKey.trim() || undefined,
              label: label.trim() || undefined,
            })
          }}
        >
          <div className="space-y-2">
            <Label className="text-xs">{t('config.providers.baseUrl')}</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              aria-invalid={attempted && !!baseUrlError}
            />
            {attempted && <FieldError error={baseUrlError} />}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.models.modelIdsPlaceholder')}</Label>
            <Textarea
              value={modelIds}
              onChange={(e) => setModelIds(e.target.value)}
              placeholder="gpt-4o-mini&#10;claude-3-5-sonnet"
              rows={4}
              aria-invalid={attempted && !!modelsError}
            />
            {attempted && <FieldError error={modelsError} />}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.models.apiKeyOptional')}</Label>
            <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.providers.label')}</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('config.providers.editLabelPlaceholder')} />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <DialogClose render={<Button type="button" variant="ghost" size="sm">{t('config.providers.cancel')}</Button>} />
            <Button type="submit" size="sm" disabled={add.isPending}>
              {add.isPending ? t('config.models.adding') : t('config.models.add')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function EditProviderDialog({ keyRow, onSaved }: { keyRow: ApiKey; onSaved: () => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState(keyRow.label ?? '')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(keyRow.baseUrl ?? '')

  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: (patch: Record<string, unknown>) =>
      apiFetch(`/api/keys/${keyRow.id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      toast.success(t('config.providers.saved'))
      setOpen(false)
      onSaved()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  })

  const isCustom = keyRow.platform === 'custom'

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="icon-sm" title={t('config.providers.editProvider')} onClick={() => setOpen(true)}>
        <Pencil />
      </Button>
      <DialogPopup maxWidth="max-w-md">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('config.providers.editProvider')}</DialogTitle>
          <DialogClose className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground">
            <X className="size-4" />
          </DialogClose>
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            const patch: Record<string, unknown> = {}
            if (label !== (keyRow.label ?? '')) patch.label = label
            if (apiKey.trim()) patch.apiKey = apiKey.trim()
            if (isCustom && baseUrl.trim() && baseUrl.trim() !== (keyRow.baseUrl ?? '')) patch.baseUrl = baseUrl.trim()
            if (Object.keys(patch).length === 0) {
              setOpen(false)
              return
            }
            save.mutate(patch)
          }}
        >
          <p className="font-mono text-xs text-muted-foreground">
            {t('config.providers.platform')}: {platformLabel(keyRow.platform)} · {t('config.providers.apiKey')}: {keyRow.maskedKey || '—'}
          </p>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.providers.label')}</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('config.providers.editLabelPlaceholder')} />
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.providers.apiKey')}</Label>
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('config.providers.editKeyPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('config.providers.replaceKeyHint')}</p>
          </div>

          {isCustom && (
            <div className="space-y-2">
              <Label className="text-xs">{t('config.providers.baseUrl')}</Label>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <DialogClose render={<Button type="button" variant="ghost" size="sm">{t('config.providers.cancel')}</Button>} />
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? t('config.providers.saving') : t('config.providers.save')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Data backup tab                                                    */
/* ------------------------------------------------------------------ */

function AddModelDialog({
  models,
  defaultPlatform,
  trigger = 'icon',
  onAdded,
}: {
  models: ConfigModel[]
  defaultPlatform?: Platform
  trigger?: 'icon' | 'text'
  onAdded: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [platform, setPlatform] = useState<Platform | ''>(defaultPlatform ?? '')
  const [referenceId, setReferenceId] = useState('')
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [supportsVision, setSupportsVision] = useState(false)
  const [supportsTools, setSupportsTools] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const platformModels = models.filter((m) => m.platform === platform)

  const openDialog = () => {
    setPlatform(defaultPlatform ?? '')
    setReferenceId('')
    setModelId('')
    setDisplayName('')
    setContextWindow('')
    setSupportsVision(false)
    setSupportsTools(false)
    setAttempted(false)
    setOpen(true)
  }

  const applyReference = (refId: string | null) => {
    const id = refId ?? ''
    setReferenceId(id)
    const ref = models.find((m) => String(m.id) === id)
    if (ref) {
      setContextWindow(ref.contextWindow != null ? String(ref.contextWindow) : '')
      setSupportsVision(ref.supportsVision)
      setSupportsTools(ref.supportsTools)
    } else {
      setContextWindow('')
      setSupportsVision(false)
      setSupportsTools(false)
    }
  }

  const add = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/models', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      toast.success(t('config.models.addModel'))
      setOpen(false)
      onAdded()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  })

  const contextNumber = contextWindow.trim() === '' ? null : Number.parseInt(contextWindow, 10)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger === 'text' ? (
        <Button variant="outline" size="sm" onClick={openDialog}>
          <Plus />
          {t('config.models.addModel')}
        </Button>
      ) : (
        <Button variant="ghost" size="icon-sm" title={t('config.models.addModel')} onClick={openDialog}>
          <Plus />
        </Button>
      )}
      <DialogPopup maxWidth="max-w-md">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('config.models.addModel')}</DialogTitle>
          <DialogClose className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground">
            <X className="size-4" />
          </DialogClose>
        </div>
        <DialogDescription className="mb-4">{t('config.models.addModelHint')}</DialogDescription>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!platform || !modelId.trim()) {
              setAttempted(true)
              return
            }
            setAttempted(false)
            add.mutate({
              platform,
              modelId: modelId.trim(),
              displayName: displayName.trim() || undefined,
              contextWindow: contextNumber,
              supportsVision,
              supportsTools,
              enabled: true,
            })
          }}
        >
          <div className="space-y-2">
            <Label className="text-xs">{t('config.providers.platform')}</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
              <SelectTrigger className="w-full" aria-invalid={attempted && !platform}>
                <SelectValue placeholder={t('validation.required')} />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {attempted && !platform && <FieldError error={t('validation.required')} />}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.models.modelId')}</Label>
            <Input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="gpt-4o-mini-2"
              autoComplete="off"
              aria-invalid={attempted && !modelId.trim()}
            />
            {attempted && !modelId.trim() && <FieldError error={t('validation.required')} />}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.providers.label')}</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="GPT-4o mini 2" />
          </div>

          {platformModels.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs">{t('config.models.referenceModel')}</Label>
              <Select value={referenceId} onValueChange={applyReference}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('config.models.noReference')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t('config.models.noReference')}</SelectItem>
                  {platformModels.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.displayName || m.modelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">{t('config.models.contextWindow')}</Label>
              <Input
                type="number"
                min={1}
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder="128000"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">{t('config.models.vision')}</Label>
              <div className="pt-1">
                <Switch size="sm" checked={supportsVision} onCheckedChange={setSupportsVision} />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('config.models.tools')}</Label>
            <div className="pt-1">
              <Switch size="sm" checked={supportsTools} onCheckedChange={setSupportsTools} />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <DialogClose render={<Button type="button" variant="ghost" size="sm">{t('config.providers.cancel')}</Button>} />
            <Button type="submit" size="sm" disabled={add.isPending}>
              {add.isPending ? t('config.models.adding') : t('config.models.add')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function BackupTab() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const pageSize = 10

  const { data: tables = [] } = useQuery<string[]>({
    queryKey: ['backup-tables'],
    queryFn: () => apiFetch<{ tables: string[] }>('/api/backups/tables').then((r) => r.tables),
  })

  const { data: list, isLoading } = useQuery<{ items: BackupMeta[]; total: number }>({
    queryKey: ['backups', page],
    queryFn: () => apiFetch(`/api/backups?page=${page}&pageSize=${pageSize}`),
  })

  const { data: schedule } = useQuery<{ schedule: BackupSchedule }>({
    queryKey: ['backup-schedule'],
    queryFn: () => apiFetch('/api/backups/schedule'),
  })

  const invalidateBackups = () => {
    queryClient.invalidateQueries({ queryKey: ['backups'] })
    queryClient.invalidateQueries({ queryKey: ['backup-schedule'] })
  }

  const createBackup = useMutation({
    meta: { silenceToast: true },
    mutationFn: (tablesToBackup: string[]) =>
      apiFetch('/api/backups', {
        method: 'POST',
        body: JSON.stringify(tablesToBackup.length > 0 ? { tables: tablesToBackup } : {}),
      }),
    onSuccess: () => {
      toast.success(t('config.backup.create'))
      setSelected(new Set())
      invalidateBackups()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  })

  const restore = useMutation({
    meta: { silenceToast: true },
    mutationFn: (id: number) => apiFetch(`/api/backups/${id}/restore`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('config.backup.restore'))
      invalidateBackups()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  })

  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/backups/${id}`, { method: 'DELETE' }),
    onSuccess: invalidateBackups,
  })

  const total = list?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-8">
      {/* Create backup */}
      <section>
        <h2 className="text-sm font-medium mb-3">{t('config.backup.create')}</h2>
        <div className="rounded-3xl border bg-card p-5">
          <p className="text-xs text-muted-foreground mb-4">{t('config.backup.selectHint')}</p>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set(tables))}
              disabled={tables.length === 0}
            >
              {t('config.backup.selectAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
              {t('config.backup.deselectAll')}
            </Button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-5">
            {tables.map((table) => (
              <label
                key={table}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-muted/30 ${
                  selected.has(table) ? 'border-ring bg-muted/50' : ''
                }`}
              >
                <input
                  type="checkbox"
                  className="size-3.5 accent-foreground"
                  checked={selected.has(table)}
                  onChange={(e) => {
                    const next = new Set(selected)
                    if (e.target.checked) next.add(table)
                    else next.delete(table)
                    setSelected(next)
                  }}
                />
                <span className="font-mono text-xs">{table}</span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => createBackup.mutate([...selected])} disabled={createBackup.isPending}>
              {t('config.backup.backupSelected', { count: selected.size })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => createBackup.mutate([])}
              disabled={createBackup.isPending}
            >
              {t('config.backup.fullBackup')}
            </Button>
          </div>
        </div>
      </section>

      {/* Backup list */}
      <section>
        <h2 className="text-sm font-medium mb-3">{t('config.backup.list')}</h2>
        <div className="rounded-3xl border bg-card overflow-hidden">
          {isLoading ? (
            <div className="p-6">
              <CardSkeleton />
            </div>
          ) : list && list.items.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('config.backup.filename')}</TableHead>
                    <TableHead>{t('config.backup.size')}</TableHead>
                    <TableHead>{t('config.backup.type')}</TableHead>
                    <TableHead>{t('config.backup.source')}</TableHead>
                    <TableHead>{t('config.backup.time')}</TableHead>
                    <TableHead className="text-right">{t('config.providers.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-mono text-xs">{item.filename}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {item.isFull ? t('config.backup.full') : t('config.backup.tablesCount', { count: item.tables.length })}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatBytes(item.filesize)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{item.isFull ? t('config.backup.full') : t('config.backup.partial')}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.source === 'scheduled' ? 'secondary' : 'outline'}>
                          {item.source === 'scheduled' ? t('config.backup.scheduled') : t('config.backup.manual')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtWhen(Date.parse(item.createdAt))}</TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={t('config.backup.download')}
                            onClick={() => downloadBackupFile(item.id, item.filename)}
                          >
                            <Download />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={restore.isPending}
                            onClick={() => {
                              if (window.confirm(t('config.backup.confirmRestore'))) restore.mutate(item.id)
                            }}
                          >
                            {t('config.backup.restore')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={t('config.backup.delete')}
                            onClick={() => {
                              if (window.confirm(t('config.backup.confirmDelete'))) remove.mutate(item.id)
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
                <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  {t('config.backup.prevPage')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {page} / {totalPages}
                </span>
                <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  {t('config.backup.nextPage')}
                </Button>
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">{t('config.backup.empty')}</div>
          )}
        </div>
      </section>

      {/* Auto backup schedule */}
      <AutoBackupSection schedule={schedule?.schedule ?? null} onSaved={invalidateBackups} />
    </div>
  )
}

function AutoBackupSection({ schedule, onSaved }: { schedule: BackupSchedule | null; onSaved: () => void }) {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(false)
  const [time, setTime] = useState('03:00')
  const [intervalDays, setIntervalDays] = useState('1')
  const [backupPath, setBackupPath] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    if (schedule) {
      setEnabled(schedule.enabled)
      setTime(schedule.time)
      setIntervalDays(String(schedule.intervalDays))
      setBackupPath(schedule.backupPath ?? '')
    }
  }, [schedule])

  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/backups/schedule', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
      onSaved()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  })

  return (
    <section>
      <h2 className="text-sm font-medium mb-3">{t('config.backup.autoBackup')}</h2>
      <div className="rounded-3xl border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{t('config.backup.enableAuto')}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t('config.backup.autoHint')}</p>
          </div>
          <Switch size="sm" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label className="text-xs">{t('config.backup.backupTime')}</Label>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{t('config.backup.intervalDays')}</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={intervalDays}
              onChange={(e) => setIntervalDays(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{t('config.backup.backupPath')}</Label>
            <Input value={backupPath} onChange={(e) => setBackupPath(e.target.value)} placeholder={t('config.backup.backupPathHint')} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                enabled,
                time: time || '03:00',
                intervalDays: Math.max(1, Number.parseInt(intervalDays, 10) || 1),
                backupPath: backupPath.trim(),
              })
            }
          >
            {savedFlash ? t('config.backup.saved') : t('config.backup.saveConfig')}
          </Button>
        </div>
      </div>
    </section>
  )
}
