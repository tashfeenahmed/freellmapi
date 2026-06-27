import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Clock3, Gauge } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'

type InspectorReason = 'penalty' | 'cooldown' | 'recent_errors'

interface PenaltyInspectorRow {
  modelDbId: number | null
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  fallbackEnabled: boolean
  priority: number | null
  penalty: {
    hits: number
    value: number
    rateLimitFactor: number
  }
  cooldowns: Array<{
    keyId: number
    keyLabel: string | null
    keyStatus: string | null
    expiresAtMs: number
    expiresInMs: number
  }>
  recentErrors: Array<{
    id: number
    keyId: number | null
    keyLabel: string | null
    error: string
    latencyMs: number
    createdAt: string
  }>
  recentErrorCount: number
  reasons: InspectorReason[]
}

interface PenaltyInspectorData {
  generatedAtMs: number
  lookbackMinutes: number
  rows: PenaltyInspectorRow[]
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.ceil(minutes / 60)
  return `${hours}h`
}

function formatTime(value: string): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function penaltyClass(value: number): string {
  if (value >= 8) return 'bg-red-600/15 text-red-700 dark:text-red-400'
  if (value >= 5) return 'bg-orange-600/15 text-orange-700 dark:text-orange-400'
  if (value >= 3) return 'bg-amber-600/15 text-amber-700 dark:text-amber-400'
  if (value > 0) return 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
  return 'bg-muted text-muted-foreground'
}

export function PenaltyInspector() {
  const { t } = useI18n()
  const { data } = useQuery<PenaltyInspectorData>({
    queryKey: ['fallback', 'penalty-inspector'],
    queryFn: () => apiFetch('/api/fallback/penalty-inspector'),
    refetchInterval: 5_000,
  })

  const rows = data?.rows ?? []
  if (rows.length === 0) return null

  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
          <div>
            <h2 className="text-sm font-medium">{t('penaltyInspector.title')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('penaltyInspector.subtitle', { minutes: data?.lookbackMinutes ?? 30 })}
            </p>
          </div>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
          {t('penaltyInspector.rowCount', { count: rows.length })}
        </span>
      </div>

      <div className="divide-y">
        {rows.map(row => (
          <div key={`${row.platform}:${row.modelId}:${row.modelDbId ?? 'missing'}`} className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(14rem,1.2fr)_minmax(10rem,0.8fr)_minmax(14rem,1.3fr)]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-medium">{row.displayName}</span>
                <span className="text-xs text-muted-foreground">{row.platform}</span>
                {!row.fallbackEnabled && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t('penaltyInspector.offChain')}
                  </span>
                )}
              </div>
              <code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{row.modelId}</code>
              <div className="mt-2 flex flex-wrap gap-1">
                {row.reasons.map(reason => (
                  <span key={reason} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t(`penaltyInspector.reasons.${reason}`)}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <Gauge className="size-3.5 text-muted-foreground" />
                <span className={`rounded-full px-2 py-0.5 tabular-nums ${penaltyClass(row.penalty.value)}`}>
                  {t('penaltyInspector.penaltyValue', { value: row.penalty.value })}
                </span>
                {row.penalty.value > 0 && (
                  <span className="text-muted-foreground tabular-nums">
                    {t('penaltyInspector.factor', { factor: row.penalty.rateLimitFactor.toFixed(2) })}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Clock3 className="size-3.5 text-muted-foreground" />
                {row.cooldowns.length === 0 ? (
                  <span className="text-muted-foreground">{t('penaltyInspector.noCooldown')}</span>
                ) : row.cooldowns.map(cooldown => (
                  <span key={`${cooldown.keyId}:${cooldown.expiresAtMs}`} className="rounded-full bg-sky-600/15 px-2 py-0.5 text-sky-700 dark:text-sky-400">
                    {t('penaltyInspector.cooldownChip', {
                      key: cooldown.keyLabel || `#${cooldown.keyId}`,
                      time: formatDuration(cooldown.expiresInMs),
                    })}
                  </span>
                ))}
              </div>
            </div>

            <div className="min-w-0">
              <div className="mb-1 text-xs text-muted-foreground">
                {t('penaltyInspector.errorsHeading', { count: row.recentErrorCount })}
              </div>
              {row.recentErrors.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('penaltyInspector.noRecentErrors')}</p>
              ) : (
                <div className="space-y-1">
                  {row.recentErrors.map(error => (
                    <div key={error.id} className="min-w-0 text-xs">
                      <span className="mr-2 text-muted-foreground tabular-nums">{formatTime(error.createdAt)}</span>
                      <span className="mr-2 text-muted-foreground">{error.keyLabel || (error.keyId ? `#${error.keyId}` : t('penaltyInspector.noKey'))}</span>
                      <span title={error.error} className="break-words">{error.error}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
