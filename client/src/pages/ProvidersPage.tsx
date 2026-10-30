import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, ShieldCheck, ShieldAlert, Stethoscope, Server } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import {
  visibleProviders, FILTERS, type Filter, type ProviderOverview, type ProviderState, type ProvidersResponse,
} from '@/lib/providers-view'

// Read-only overview backed by GET /api/providers. Actions reuse the existing
// endpoints: POST /api/health/check/:id (test a key), POST /api/health/check-all,
// PATCH /api/keys/:id (enable/disable), POST /api/premium/sync (catalog resync),
// and the Keys page's ?add=<platform> deep link for adding a key.

function stateVariant(state: ProviderState): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (state === 'connected') return 'default'
  if (state === 'unhealthy') return 'destructive'
  if (state === 'disabled') return 'secondary'
  return 'outline'
}

function formatTime(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

function ProviderCard({ provider }: { provider: ProviderOverview }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['providers'] })
  const testKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => { toast.success(t('providers.checkDone')); void refresh() },
    onError: () => toast.error(t('providers.checkFailed')),
  })
  const toggleKey = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => void refresh(),
    onError: () => toast.error(t('providers.toggleFailed')),
  })

  const meta = provider.metadata
  const lastCheck = formatTime(provider.lastCheckedAt)
  const cooldownEnd = formatTime(provider.cooldowns.soonestExpiresAt)
  const { traffic24h: traffic } = provider

  return (
    <li className="rounded-lg border bg-card p-4 space-y-3" data-testid={`provider-${provider.platform}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium text-base mr-auto break-all">{provider.name}</h2>
        <Badge variant={stateVariant(provider.state)}>{t(`providers.state.${provider.state}`)}</Badge>
        <Badge variant="outline">{t(`providers.freeTier.${meta.freeTier}`)}</Badge>
      </div>

      <p className="text-sm text-muted-foreground">{meta.summary}</p>

      <div className="flex items-start gap-2 text-sm">
        {provider.automaticRouting.eligible
          ? <ShieldCheck className="size-4 mt-0.5 shrink-0 text-emerald-600" aria-hidden />
          : <ShieldAlert className="size-4 mt-0.5 shrink-0 text-amber-600" aria-hidden />}
        <span data-testid="auto-routing">
          {provider.automaticRouting.eligible
            ? t('providers.autoEligible', { auto: provider.models.automaticallyRoutable, enabled: provider.models.enabled })
            : t('providers.autoBlocked', { reason: provider.automaticRouting.reason ?? '' })}
        </span>
      </div>

      {(meta.restrictions.length > 0 || meta.trainsOnPrompts) && (
        <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-0.5">
          {meta.trainsOnPrompts && <li>{t('providers.trainsOnPrompts')}</li>}
          {meta.restrictions.map(r => <li key={r}>{r}</li>)}
        </ul>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div><dt className="inline text-muted-foreground">{t('providers.lastCheckLabel')} </dt><dd className="inline">{lastCheck ?? t('providers.neverChecked')}</dd></div>
        <div>
          <dt className="inline text-muted-foreground">{t('providers.trafficLabel')} </dt>
          <dd className="inline">
            {traffic.requests > 0
              ? t('providers.traffic', {
                  requests: traffic.requests,
                  success: traffic.successRate != null ? Math.round(traffic.successRate * 100) : 0,
                  latency: traffic.avgLatencyMs ?? 0,
                })
              : t('providers.noTraffic')}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">{t('providers.cooldownLabel')} </dt>
          <dd className="inline">
            {provider.cooldowns.active > 0 ? t('providers.cooldowns', { count: provider.cooldowns.active, time: cooldownEnd ?? '' }) : t('providers.noCooldowns')}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">{t('providers.quotaLabel')} </dt>
          <dd className="inline" data-testid="quota">
            {provider.providerReportedQuota.length > 0
              ? provider.providerReportedQuota.map(q => t('providers.providerQuota', {
                  remaining: q.remaining ?? '?', limit: q.limit ?? '?', metric: q.metric,
                })).join(' · ')
              : t('providers.noQuota')}
          </dd>
        </div>
      </dl>

      <div className="text-xs text-muted-foreground space-y-0.5" data-testid="verification">
        <p>
          {provider.verification.status === 'officially-verified'
            ? t('providers.verified', { date: provider.verification.verifiedOn ?? '' })
            : provider.verification.status === 'repo-documented'
              ? t('providers.repoDocumented', { level: t(`providers.confidence.${meta.confidence}`) })
              : t('providers.noEvidence')}
        </p>
        {meta.docsUrl && (
          <a href={meta.docsUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-2">
            {t('providers.docs')}<ExternalLink className="size-3" aria-hidden />
            {meta.docsUrlSource === 'unchecked' && <span>({t('providers.docsUnchecked')})</span>}
          </a>
        )}
      </div>

      {provider.keys.items.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {provider.keys.items.map(key => (
            <li key={key.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="mr-auto break-all">{key.label ?? `#${key.id}`}</span>
              <Badge variant={key.status === 'healthy' ? 'default' : key.status === 'unknown' ? 'outline' : 'destructive'}>{key.status}</Badge>
              <Button
                size="sm"
                variant="outline"
                disabled={testKey.isPending}
                onClick={() => testKey.mutate(key.id)}
              >
                <Stethoscope className="size-3.5" aria-hidden />{t('providers.test')}
              </Button>
              <Switch
                size="sm"
                aria-label={t('providers.enableKey', { key: key.label ?? `#${key.id}` })}
                checked={key.enabled}
                disabled={toggleKey.isPending}
                onCheckedChange={enabled => toggleKey.mutate({ id: key.id, enabled })}
              />
              {key.lastHealthError && <p className="basis-full text-xs text-destructive break-words">{key.lastHealthError}</p>}
            </li>
          ))}
        </ul>
      ) : provider.credentialsRequired ? (
        <Link to={`/keys?add=${encodeURIComponent(provider.platform)}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          {t('providers.addKey')}
        </Link>
      ) : (
        <p className="text-xs text-muted-foreground">{t('providers.keylessHint')}</p>
      )}
    </li>
  )
}

export default function ProvidersPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  // No polling: the page refreshes when opened and after an action, so it costs
  // nothing on an idle phone.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['providers'],
    queryFn: () => apiFetch<ProvidersResponse>('/api/providers'),
    staleTime: 30_000,
  })
  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => { toast.success(t('providers.checkDone')); void queryClient.invalidateQueries({ queryKey: ['providers'] }) },
    onError: () => toast.error(t('providers.checkFailed')),
  })
  const resync = useMutation({
    mutationFn: () => apiFetch('/api/premium/sync', { method: 'POST' }),
    onSuccess: () => { toast.success(t('providers.resyncDone')); void queryClient.invalidateQueries({ queryKey: ['providers'] }) },
    onError: () => toast.error(t('providers.resyncFailed')),
  })

  const shown = useMemo(() => visibleProviders(data?.providers ?? [], filter, query), [data, filter, query])

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <PageHeader
        title={t('providers.title')}
        description={t('providers.description')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={checkAll.isPending} onClick={() => checkAll.mutate()}>
              <Stethoscope className="size-3.5" aria-hidden />{t('providers.checkAll')}
            </Button>
            <Button size="sm" variant="outline" disabled={resync.isPending} onClick={() => resync.mutate()}>
              <RefreshCw className={cn('size-3.5', resync.isPending && 'animate-spin')} aria-hidden />{t('providers.resync')}
            </Button>
          </div>
        }
      />

      {data && (
        <div className="mb-4 space-y-2 text-sm" data-testid="free-only-banner">
          <p className={cn('rounded-md border px-3 py-2', !data.freeOnly.enabled && 'border-destructive text-destructive')}>
            {data.freeOnly.enabled ? t('providers.freeOnlyOn') : t('providers.freeOnlyOff')}
          </p>
          {data.freeOnly.optedIn.filter(o => o.warning).map(o => (
            <p key={o.platform} className="rounded-md border border-amber-500/60 px-3 py-2">
              {t('providers.optedIn', { platform: o.platform, warning: o.warning ?? '' })}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">{t('providers.quotaNote')}</p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('providers.search')}
          aria-label={t('providers.search')}
          className="sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('providers.filterLabel')}>
          {FILTERS.map(f => (
            <Button key={f} size="sm" variant={filter === f ? 'default' : 'ghost'} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? t('providers.filterAll') : t(`providers.state.${f}`)}
            </Button>
          ))}
        </div>
      </div>

      {isLoading && <div className="space-y-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-40 w-full" />)}</div>}
      {isError && <p className="text-sm text-destructive">{t('providers.loadFailed')}</p>}
      {data && shown.length === 0 && (
        <EmptyState icon={Server} title={t('providers.emptyTitle')} description={t('providers.emptyDescription')} />
      )}
      {shown.length > 0 && <ul className="space-y-3">{shown.map(p => <ProviderCard key={p.platform} provider={p} />)}</ul>}
    </div>
  )
}
