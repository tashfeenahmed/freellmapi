import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Tooltip } from '@/components/tooltip'

// Provider-moment failure attribution (#1347, opt-in): tag 429 / 5xx /
// timeout / transport failures as the provider's bad minute so they steer the
// key without counting against the model's reliability. Independent of the
// routing-strategy snapshot — it lives in settings, so it owns its own
// query + mutation. Off by default; existing installs keep today's scoring.
async function fetchAttribution(): Promise<{ enabled: boolean }> {
  return apiFetch('/api/settings/provider-moment-attribution')
}

export function ProviderMomentControl() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings', 'provider-moment-attribution'], queryFn: fetchAttribution })
  const enabled = data?.enabled ?? false

  const mutation = useMutation({
    mutationFn: (value: boolean) =>
      apiFetch('/api/settings/provider-moment-attribution', {
        method: 'PUT',
        body: JSON.stringify({ enabled: value }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'provider-moment-attribution'] }),
  })

  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t('strategies.providerMomentAttribution')}</span>
      <input
        type="checkbox"
        checked={enabled}
        disabled={mutation.isPending}
        onChange={e => mutation.mutate(e.target.checked)}
        className="h-3.5 w-3.5 accent-foreground"
      />
      <Tooltip text={t('strategies.providerMomentAttributionHint')}>
        <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
      </Tooltip>
    </label>
  )
}
