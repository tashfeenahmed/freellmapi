import { Link } from 'react-router-dom'
import { useI18n } from '@/i18n'
import { searchReadinessHint, type SearchReadiness } from '@/lib/search'

export function SearchReadinessNotice({ data, failed, loading, available, error, onRetry }: {
  data?: SearchReadiness; failed: boolean; loading: boolean; available: boolean
  error?: Error | null; onRetry: () => void
}) {
  const { t, locale } = useI18n()
  if ((loading && !failed) || (available && !failed)) return null
  const catalog = data?.catalog
  const hint = searchReadinessHint(data, failed, loading, t)
  const syncProblem = catalog?.lastError ? t('premium.lastSyncProblem', { error: catalog.lastError }) : null
  return (
    <div role={failed ? 'alert' : 'status'} className="rounded-xl border p-4 text-sm space-y-2">
      <p>{hint}</p>
      {failed && error && <p className="break-words text-xs text-muted-foreground">{error.message}</p>}
      {catalog && <p className="text-xs text-muted-foreground">
        {catalog.appliedTier === 'live' ? t('premium.liveFeed') : t('premium.monthlySnapshot')} · {catalog.appliedVersion ?? t('premium.bundled')}
        {' · '}{t('premium.lastChecked', { when: catalog.lastSyncMs ? new Date(catalog.lastSyncMs).toLocaleString(locale) : t('common.never') })}
      </p>}
      {syncProblem && syncProblem !== hint && <p className="break-words text-xs text-destructive">{syncProblem}</p>}
      <div className="flex flex-wrap gap-4 text-xs underline">
        <Link to="/keys">{t('nav.keys')}</Link>
        <Link to="/premium">{t('premium.catalogFeed')}</Link>
        <button type="button" onClick={onRetry}>{t('updates.tryAgain')}</button>
      </div>
    </div>
  )
}
