import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/empty-state'
import { CardSkeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { UsageSummaryCard } from '@/components/usage-summary-card'
import { useI18n } from '@/i18n'
import { engineChain, freeFromDate, type SearchAnalytics, type SearchEngine } from '@/lib/search'

const pill = 'text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground'

// One engine from the catalog's `searchEngines` section. Its position in the
// failover order is shown as a number; the first enabled engine is the
// default, and any other can be promoted to it in one click.
function SearchEngineCard({
  engine: e,
  position,
  isDefault,
  onToggle,
  onMakeDefault,
  pending,
}: {
  engine: SearchEngine
  position: number | null
  isDefault: boolean
  onToggle: (enabled: boolean) => void
  onMakeDefault: () => void
  pending: boolean
}) {
  const { t, locale } = useI18n()
  const test = useMutation({
    mutationFn: () => apiFetch(`/api/search/engines/${e.id}/test`, {
      method: 'POST', body: JSON.stringify({ query: 'OpenAI' }),
    }),
  })
  const freeFrom = freeFromDate(e.premiumSince)
  const features = e.features ?? {}
  return (
    <section className={`rounded-3xl border bg-card p-5 ${e.enabled ? '' : 'opacity-60'}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{e.engineId}</span>
        {e.creditsPerQuery != null && (
          <span className={`${pill} tabular-nums`}>
            {e.creditsPerQuery === 1
              ? t('search.creditsPerSearchOne')
              : t('search.creditsPerSearchOther', { count: e.creditsPerQuery })}
          </span>
        )}
        {freeFrom && (
          <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
            {t('search.premiumBadge', {
              date: freeFrom.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
            })}
          </span>
        )}
        {features.news && <span className={pill}>{t('search.featureNews')}</span>}
        {features.answer && <span className={pill}>{t('search.featureAnswer')}</span>}
        {features.fullContent && <span className={pill}>{t('search.featureFullContent')}</span>}
        {isDefault ? (
          <span className="text-xs text-muted-foreground">{t('search.default')}</span>
        ) : e.enabled && (
          <button
            type="button"
            onClick={onMakeDefault}
            disabled={pending}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            {t('search.makeDefault')}
          </button>
        )}
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('search.thisMonth', { count: e.searchesThisMonth })}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="w-4 text-center text-xs text-muted-foreground tabular-nums">{position ?? '–'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{e.displayName}</span>
            {e.keyCount === 0 && (
              <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
                {t('models.noKey')}
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {[e.platform, e.quotaLabel].filter(Boolean).join(' · ')}
          </div>
        </div>
        <Switch
          checked={e.enabled}
          onCheckedChange={onToggle}
          disabled={pending}
          aria-label={e.displayName}
        />
        <button type="button" className="text-xs underline disabled:opacity-50"
          onClick={() => test.mutate()} disabled={!e.enabled || e.keyCount === 0 || test.isPending}>
          {test.isPending ? t('common.loading') : t('keys.testModel')}
        </button>
      </div>
      {test.isSuccess && <p role="status" className="mt-2 text-xs">{t('common.success')}</p>}
      {test.isError && <p role="alert" className="mt-2 text-xs text-destructive">{test.error.message}</p>}
    </section>
  )
}

// Models → Search: the catalog's search engines in failover order, with the
// same month-to-date usage card the media tabs use. Rows sync from the signed
// catalog like every other modality; the toggles and "Make default" are the
// operator's local overrides.
export function SearchEnginesView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: engines = [], isLoading } = useQuery<SearchEngine[]>({
    queryKey: ['search-engines'],
    queryFn: () => apiFetch('/api/search/engines'),
    refetchInterval: 30_000,
  })

  // Only `today` is read here; the month total is the sum of the engine rows.
  const { data: analytics } = useQuery<SearchAnalytics>({
    queryKey: ['analytics', 'search', '30d'],
    queryFn: () => apiFetch('/api/analytics/search?range=30d'),
    refetchInterval: 30_000,
  })

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: number; enabled?: boolean; priority?: number }) =>
      apiFetch(`/api/search/engines/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['search-engines'] }),
  })

  const ordered = engines
    .slice()
    .sort((a, b) => a.priority - b.priority || a.displayName.localeCompare(b.displayName))
  const chain = engineChain(engines)
  const positions = new Map(chain.map((e, i) => [e.id, i + 1]))
  const total = engines.reduce((n, e) => n + e.searchesThisMonth, 0)

  return (
    <div>
      <PageHeader title={t('models.title')} description={t('search.pageDesc')} divider={false} actions={<ModelsTabs />} />

      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t('search.endpointHint')}{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">POST /v1/search</code>{' '}
          {t('search.agentsHint')}
        </p>

        {engines.length > 0 && (
          <UsageSummaryCard
            unit="requests"
            total={total}
            requestsToday={analytics?.today ?? 0}
            rows={ordered.map(e => ({
              label: e.displayName,
              platform: e.platform,
              quotaLabel: e.quotaLabel,
              amount: e.searchesThisMonth,
              requestsToday: 0,
            }))}
          />
        )}

        {isLoading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : ordered.length === 0 ? (
          <EmptyState icon={Globe} title={t('search.empty')} />
        ) : (
          ordered.map(e => (
            <SearchEngineCard
              key={e.id}
              engine={e}
              position={positions.get(e.id) ?? null}
              isDefault={chain[0]?.id === e.id}
              onToggle={enabled => update.mutate({ id: e.id, enabled })}
              onMakeDefault={() => update.mutate({ id: e.id, priority: 0 })}
              pending={update.isPending}
            />
          ))
        )}
      </div>
    </div>
  )
}
