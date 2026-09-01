import { useI18n } from '@/i18n'
import { formatTokens, platformColors } from '@/lib/routing'

// Month-to-date spend for the embedding / image / audio tabs, in the same card
// slot the chat tab uses for its budget bar.
//
// It is deliberately NOT a budget bar. Chat can draw a percentage because
// `models.monthly_token_budget` is a real number. `embedding_models` and
// `media_models` only carry a free-text `quota_label` — "10K neurons/day
// (shared)", "$0.10/mo credits", "MP3 output - multilingual" — and there is no
// honest conversion from Neurons or dollar credits to tokens, nor is the last
// one a quota at all. So the bar shows how spend is *distributed* across
// providers (which is real), the total is what was actually spent, and each
// provider's quota label is printed verbatim for the reader to judge.
export interface UsageRow {
  /** Family name for embeddings, model display name for media. */
  label: string
  platform: string | null
  quotaLabel?: string | null
  /** Whichever unit this modality is metered in. */
  amount: number
  requestsToday: number
}

export function UsageSummaryCard({
  rows,
  total,
  requestsToday,
  unit,
}: {
  rows: UsageRow[]
  total: number
  requestsToday: number
  /** 'tokens' for embeddings, 'requests' for image/audio (billed per image or per character). */
  unit: 'tokens' | 'requests'
}) {
  const { t } = useI18n()
  const spent = rows.filter(r => r.amount > 0)
  const fmt = (n: number) => (unit === 'tokens' ? formatTokens(n) : String(n))

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-medium">{t('models.usageThisMonth')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {unit === 'tokens'
            ? t('embeddings.usageMonth', { count: fmt(total) })
            : t('models.usageRequestsMonth', { count: total })}
          <span className="mx-1.5">·</span>
          {t('embeddings.usageToday', { count: requestsToday })}
        </span>
      </div>

      {/* The track always renders. Hiding it at zero made the whole card read as
          missing on tabs with no traffic yet, which is exactly when a reader is
          checking whether the feature is there at all. */}
      {total > 0 ? (
        <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
          {spent.map((r, i) => (
            <div
              key={i}
              title={`${r.label}${r.platform ? ` (${r.platform})` : ''}: ${fmt(r.amount)}`}
              style={{
                width: `${(r.amount / total) * 100}%`,
                backgroundColor: platformColors[r.platform ?? ''] ?? '#94a3b8',
              }}
            />
          ))}
        </div>
      ) : (
        <div className="h-2.5 rounded-full bg-muted" />
      )}

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2 min-w-0">
            <span
              className="size-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: platformColors[r.platform ?? ''] ?? '#94a3b8' }}
            />
            <span className="truncate">{r.label}</span>
            {r.quotaLabel && (
              <span className="truncate text-muted-foreground/70 font-normal">{r.quotaLabel}</span>
            )}
            <span className="flex-1" />
            <span className="font-mono text-muted-foreground">{fmt(r.amount)}</span>
          </div>
        ))}
      </div>

      {total === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">{t('models.usageEmpty')}</p>
      )}
    </section>
  )
}
