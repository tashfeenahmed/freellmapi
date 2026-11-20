import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

// #1870: one quiet line for installs that existed before no-key providers were
// switched on by default: "No-key providers available (N) · Enable all · ×".
// The server only counts providers this install's catalog tier lists, so a
// free install sees one here once it is past the 30-day lag, not before.
interface KeylessAvailable {
  providers: { platform: string; name: string }[]
}

export function KeylessNotice() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data } = useQuery<KeylessAvailable>({
    queryKey: ['keyless-available'],
    queryFn: () => apiFetch('/api/keys/keyless-available'),
  })
  // Enabling adds keys and models, so everything that lists them refreshes.
  const refresh = () => queryClient.invalidateQueries()
  const enableAll = useMutation({
    mutationFn: () => apiFetch('/api/keys/keyless-available/enable', { method: 'POST' }),
    onSettled: refresh,
  })
  const dismiss = useMutation({
    mutationFn: () => apiFetch('/api/keys/keyless-available/dismiss', { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['keyless-available'] }),
  })

  // Tolerates any shape (an older server without this endpoint, test mocks).
  const providers = Array.isArray(data?.providers) ? data.providers : []
  const count = providers.length
  if (count === 0) return null

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="keyless-notice">
      <span title={providers.map(p => p.name).join(', ')}>{t('keys.keylessAvailable', { count })}</span>
      <Button variant="outline" size="sm" onClick={() => enableAll.mutate()} disabled={enableAll.isPending || dismiss.isPending}>
        {t('keys.keylessEnableAll')}
      </Button>
      <button
        type="button"
        aria-label={t('common.dismiss')}
        onClick={() => dismiss.mutate()}
        disabled={enableAll.isPending || dismiss.isPending}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
