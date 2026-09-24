import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { QuotaOutlookPool, QuotaOutlookResponse } from '../../../../shared/types'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PLATFORMS } from './shared'

function OutlookPool({ pool, generatedAt, windowMinutes, minimumRequests }: {
  pool: QuotaOutlookPool; generatedAt: string; windowMinutes: number; minimumRequests: number
}) {
  const { t, locale } = useI18n()
  const number = (value: number) => new Intl.NumberFormat(locale).format(value)
  const unknown = t('keys.outlookInsufficient')
  const status = pool.warning === 'low_balance' ? t('keys.outlookLowBalance')
    : pool.warning === 'exhausting_soon' ? t('keys.outlookRunningLow')
    : pool.status === 'stale' ? t('keys.outlookStale')
    : pool.status === 'unknown' || pool.status === 'unavailable' ? t('keys.outlookUnavailable')
    : pool.status === 'insufficient_data' ? unknown : t('keys.outlookWithinQuota')
  const exhaustion = pool.estimatedExhaustionAt
    ? new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(
      Math.max(1, Math.ceil((Date.parse(pool.estimatedExhaustionAt) - Date.parse(generatedAt)) / 60_000)), 'minute')
    : pool.status === 'resets_first' ? t('keys.outlookResetsFirst')
    : pool.status === 'exhausted' ? t('keys.outlookExhausted')
    : pool.unavailableReason ? t('keys.outlookUnavailable') : unknown
  const reportedOnly = pool.unavailableReason != null
  const name = PLATFORMS.find(platform => platform.value === pool.platform)?.label ?? pool.platform
  return (
    <article aria-label={name} className={cn('p-4 sm:p-5', pool.warning && 'bg-amber-500/5')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><h3 className="text-sm font-medium">{name}</h3><p className="mt-0.5 break-all text-xs text-muted-foreground">{pool.pool}</p></div>
        <Badge variant="outline" className={cn('h-auto max-w-[50%] shrink-0 whitespace-normal text-right', pool.warning && 'border-amber-600/30 text-amber-700 dark:text-amber-300')}>
          {pool.warning && <AlertTriangle aria-hidden="true" className="mr-1 shrink-0" />}{status}
        </Badge>
      </div>
      {pool.remainingPct != null && pool.remaining != null && pool.limit != null ? (
        <>
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <div><strong className="text-xl font-medium tabular-nums text-foreground">{number(pool.remaining)}</strong>{' / '}{number(pool.limit)}{' '}{t(reportedOnly ? 'keys.outlookLastReported' : 'keys.outlookRequestsLeft')}</div>
            <span className="tabular-nums text-foreground">{number(pool.remainingPct)}%</span>
          </div>
          <div className="my-3 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t('keys.quotaRemaining')} aria-valuenow={pool.remainingPct} aria-valuemin={0} aria-valuemax={100}>
            <div className={cn('h-full rounded-full bg-foreground/40', pool.warning && 'bg-amber-500/80')} style={{ width: `${pool.remainingPct}%` }} />
          </div>
        </>
      ) : <p className="my-3 text-sm text-muted-foreground">{pool.remaining != null
        ? `${number(pool.remaining)} ${t('keys.outlookLastReported')}` : t('keys.outlookNotReported')}</p>}
      <dl className="grid gap-3 text-xs sm:grid-cols-3">
        <div><dt className="text-muted-foreground">{t('keys.outlookRate')}</dt><dd className="mt-1">{t('keys.outlookRateValue', { count: number(pool.ratePerMin) })}</dd></div>
        <div><dt className="text-muted-foreground">{t('keys.outlookRunsOut')}</dt><dd className={cn('mt-1', pool.warning && 'text-amber-700 dark:text-amber-300')}>{exhaustion}</dd></div>
        <div><dt className="text-muted-foreground">{t('keys.quotaReset')}</dt><dd className="mt-1">{pool.resetAt ? new Date(pool.resetAt).toLocaleString(locale) : t('keys.outlookNotReported')}</dd></div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">{t('keys.outlookTraffic', { count:number(pool.recentRequestCount),minutes:windowMinutes })}</p>
      {pool.recentRequestCount < minimumRequests && <p className="mt-1 text-xs text-muted-foreground">{t('keys.outlookMinimumTraffic', { count:minimumRequests,minutes:windowMinutes })}</p>}
      {pool.unavailableReason && <p className="mt-2 text-xs text-muted-foreground">{t(
        pool.unavailableReason === 'quota_not_reported' ? 'keys.outlookNotReportedHint'
          : pool.unavailableReason === 'reset_not_reported' ? 'keys.outlookMissingResetHint'
          : pool.unavailableReason === 'low_confidence' ? 'keys.outlookConfidenceHint' : 'keys.outlookStaleHint')}
      </p>}
      {reportedOnly && pool.observedAt && pool.remaining != null && <p className="mt-1 text-xs text-muted-foreground">{t('keys.outlookObserved', {
        time:new Date(pool.observedAt.includes('T') ? pool.observedAt : pool.observedAt.replace(' ', 'T') + 'Z').toLocaleString(locale),
      })}</p>}
    </article>
  )
}

export function QuotaOutlookSection() {
  const { t } = useI18n()
  const { data, isPending, isError, refetch } = useQuery<QuotaOutlookResponse>({
    queryKey: ['quota-outlook'],
    queryFn: () => apiFetch('/api/fallback/quota-forecast'),
    refetchInterval: 30_000,
  })
  const warnings = data?.pools.filter(pool => pool.warning).length ?? 0
  const available = data?.pools.filter(pool => !pool.unavailableReason) ?? []
  const unavailable = data?.pools.filter(pool => pool.unavailableReason) ?? []
  const forecasts = available.filter(pool => pool.status !== 'insufficient_data').length
  const renderPool = (pool: QuotaOutlookPool) => <OutlookPool key={pool.pool} pool={pool} generatedAt={data!.generatedAt}
    windowMinutes={data!.observationWindowMinutes} minimumRequests={data!.minimumRequests} />
  return (
    <section aria-label={t('keys.outlookTitle')}>
      <h2 className="text-sm font-medium">{t('keys.outlookTitle')}</h2>
      {isPending ? <p className="mt-3 text-sm text-muted-foreground" role="status">{t('common.loading')}</p>
        : isError ? <div className="mt-3 flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-muted-foreground">{t('keys.outlookError')}</p><Button size="sm" variant="outline" onClick={() => void refetch()}>{t('keys.outlookRetry')}</Button></div>
        : !data?.pools.length ? <p className="mt-3 text-sm text-muted-foreground">{t('keys.quotaSignalsEmptyDesc')}</p>
        : <>
          <p className="mb-4 mt-1 text-xs text-muted-foreground">{warnings > 0 ? t('keys.outlookAttention', { count: warnings }) : forecasts ? t('keys.outlookNoWarnings') : t('keys.outlookNoForecasts')}</p>
          <p className="mb-3 text-xs text-muted-foreground">{t('keys.outlookCoverage', { count:forecasts,total:data.pools.length })}{' '}
            {t('keys.outlookTraffic', { count:data.pools.reduce((sum,pool)=>sum+pool.recentRequestCount,0),minutes:data.observationWindowMinutes })}</p>
          {available.length > 0 && <div className="divide-y overflow-hidden rounded-3xl border bg-card">{available.map(renderPool)}</div>}
          {unavailable.length > 0 && <details className="mt-3 overflow-hidden rounded-3xl border bg-card">
            <summary className="cursor-pointer px-4 py-3 text-sm sm:px-5">{t('keys.outlookUnavailablePools', { count:unavailable.length })}</summary>
            <div className="divide-y border-t">{unavailable.map(renderPool)}</div>
          </details>}
        </>}
      <p className="mt-3 text-xs text-muted-foreground">{t('keys.outlookHint')}</p>
    </section>
  )
}
