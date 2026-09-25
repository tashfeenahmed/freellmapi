import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Tooltip } from '@/components/tooltip'

// Minimum reliability floor (#filter): drop models whose observed success rate
// falls below this decimal from routing. Independent of the routing-strategy
// snapshot — it lives in settings, so it has its own query + mutation.
async function fetchFloor(): Promise<number | null> {
  const data = await apiFetch<{ floor: number | null }>('/api/settings/min-reliability-floor')
  return data.floor
}

export function ReliabilityFloorControl() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings', 'min-reliability-floor'], queryFn: fetchFloor })
  const floor = data ?? null

  const [text, setText] = useState(floor == null ? '' : String(floor))
  // Re-sync when the server value changes under us (poll, or another tab).
  useEffect(() => { setText(floor == null ? '' : String(floor)) }, [floor])

  const mutation = useMutation({
    mutationFn: (value: number | null) =>
      apiFetch('/api/settings/min-reliability-floor', {
        method: 'PUT',
        body: JSON.stringify({ floor: value }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'min-reliability-floor'] }),
  })

  const invalid = text !== '' && (!/^0?\.\d+$|^1(\.0+)?$|^0$/.test(text) || Number(text) > 1)

  function commit(next: string) {
    setText(next)
    if (next === '') { mutation.mutate(null); return }
    const n = Number(next)
    if (Number.isFinite(n) && n >= 0 && n <= 1) mutation.mutate(n)
  }

  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t('strategies.minReliabilityFloor')}</span>
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        value={text}
        placeholder={t('strategies.minReliabilityFloorOff')}
        disabled={mutation.isPending}
        onChange={e => commit(e.target.value)}
        className="w-16 rounded-lg border bg-background px-2 py-1.5 text-xs text-foreground tabular-nums outline-none focus:border-foreground/30"
      />
      <Tooltip text={t('strategies.minReliabilityFloorHint')}>
        <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
      </Tooltip>
      {invalid && <span className="text-destructive">0–1</span>}
    </label>
  )
}
