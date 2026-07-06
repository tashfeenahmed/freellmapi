import type { ProviderQuotaState } from '../../../../shared/types'
import { EmptyState } from '@/components/empty-state'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useI18n } from '@/i18n'

function formatQuotaNumber(value: number | null): string {
  return value == null ? '—' : new Intl.NumberFormat().format(value)
}

function formatResetAt(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export function QuotaSignalsSection({ states }: { states: ProviderQuotaState[] }) {
  const { t } = useI18n()
  return (
    <section>
      <h2 className="text-sm font-medium mb-3">{t('keys.quotaSignalsTitle')}</h2>
      {states.length === 0 ? (
        <EmptyState title={t('keys.quotaSignalsEmptyTitle')} description={t('keys.quotaSignalsEmptyDesc')} className="bg-card" />
      ) : (
        <div className="rounded-3xl border divide-y bg-card overflow-hidden">
          {states.map((state) => (
            <div key={`${state.platform}:${state.keyId}:${state.quotaPoolKey}:${state.metric}`} className="px-4 py-3.5 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{state.platform}</span>
                <span className="text-muted-foreground">{t('keys.quotaKeyRef', { id: state.keyId })}</span>
                <span className="text-muted-foreground">{t('keys.quotaPoolRef', { pool: state.quotaPoolKey })}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{state.metric}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {state.source} · {Math.round(state.confidence * 100)}%
                </span>
              </div>
              <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                <div><span className="text-foreground">{t('keys.quotaLimit')}</span> {formatQuotaNumber(state.limit)}</div>
                <div><span className="text-foreground">{t('keys.quotaRemaining')}</span> {formatQuotaNumber(state.remaining)}</div>
                <div><span className="text-foreground">{t('keys.quotaReset')}</span> {formatResetAt(state.resetAt)}</div>
                <div><span className="text-foreground">{t('keys.quotaObserved')}</span> {formatSqliteUtcToLocalTime(state.observedAt, { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              {state.notes && (
                <p className="mt-2 text-xs text-muted-foreground">{state.notes}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
