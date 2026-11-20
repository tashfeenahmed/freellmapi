import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Tooltip } from '@/components/tooltip'

// Custom relay 5xx fallback granularity (#651 family): 'model' (default) skips
// only the failing relay's model row so sibling relays stay in play; 'platform'
// keeps the original #788 behaviour (skip the whole custom platform). Lives in
// settings, so it owns its own query + mutation.
async function fetchMode(): Promise<{ mode: 'model' | 'platform' }> {
  return apiFetch('/api/settings/custom-fallback-mode')
}

export function CustomFallbackModeControl() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings', 'custom-fallback-mode'], queryFn: fetchMode })
  const mode = data?.mode ?? 'model'

  const mutation = useMutation({
    mutationFn: (value: 'model' | 'platform') =>
      apiFetch('/api/settings/custom-fallback-mode', {
        method: 'PUT',
        body: JSON.stringify({ mode: value }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'custom-fallback-mode'] }),
  })

  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t('strategies.customFallbackMode')}</span>
      <select
        value={mode}
        disabled={mutation.isPending}
        onChange={e => mutation.mutate(e.target.value as 'model' | 'platform')}
        className="h-7 rounded border bg-background px-1 text-xs"
      >
        <option value="model">{t('strategies.customFallbackModeModel') || 'Model-level'}</option>
        <option value="platform">{t('strategies.customFallbackModePlatform') || 'Platform-level'}</option>
      </select>
      <Tooltip text={t('strategies.customFallbackModeHint')}>
        <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
      </Tooltip>
    </label>
  )
}