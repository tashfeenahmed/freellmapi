import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { X } from 'lucide-react'
import type { ApiKey } from '../../../../shared/types'
import { useI18n } from '@/i18n'

// AddCustomModelDialog — single dialog used by both Drawer entry points (header
// "+ add" and per-key section "+ add"). The only difference between entries is
// the initial keys-checklist selection, controlled via defaultSelectedKeyIds:
//   - header  → all baseUrl's keys pre-selected (batch fan-out)
//   - section → just that one key pre-selected (precise extension)
// Submit posts { keyIds, modelId, displayName? } to POST /api/models. Server
// returns { created: number[], updated: number[] }; we surface both counts.
// (#custom-platform-model-management)

interface Props {
  open: boolean
  onClose: () => void
  baseUrl: string
  keys: ApiKey[]
  defaultSelectedKeyIds: number[]
  onSubmitted?: (result: { created: number[]; updated: number[] }) => void
}

export function AddCustomModelDialog({ open, onClose, baseUrl, keys, defaultSelectedKeyIds, onSubmitted }: Props) {
  const { t } = useI18n()
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [selected, setSelected] = useState<Set<number>>(() => new Set(defaultSelectedKeyIds))
  const [error, setError] = useState<string | null>(null)
  const [resultText, setResultText] = useState<string | null>(null)

  const submit = useMutation({
    mutationFn: (body: { keyIds: number[]; modelId: string; displayName?: string }) =>
      apiFetch<{ created: number[]; updated: number[] }>('/api/models', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      const summary = `+${result.created.length} created, ${result.updated.length} updated`
      setResultText(summary)
      setError(null)
      onSubmitted?.(result)
    },
    onError: (e: any) => {
      setError(e?.message ?? 'Failed to add model')
      setResultText(null)
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const id = modelId.trim()
    if (!id) {
      setError('modelId is required')
      return
    }
    const keyIds = Array.from(selected)
    if (keyIds.length === 0) {
      setError('Select at least one key')
      return
    }
    submit.mutate({
      keyIds,
      modelId: id,
      displayName: displayName.trim() || undefined,
    })
  }

  function toggleKey(id: number) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(keys.map(k => k.id)))
  }
  function selectNone() {
    setSelected(new Set())
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-2xl border bg-background shadow-xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">{t('models.add')}</h2>
            <p className="text-xs text-muted-foreground truncate">{baseUrl}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">modelId</Label>
            <Input
              value={modelId}
              onChange={e => setModelId(e.target.value)}
              placeholder="qwen3:8b"
              className="font-mono text-xs"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">displayName</Label>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={modelId || t('keys.customDisplayNameOptional')}
              className="text-xs"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Keys ({selected.size}/{keys.length})</Label>
              <div className="flex gap-1.5">
                <Button type="button" variant="ghost" size="xs" onClick={selectAll}>
                  All
                </Button>
                <Button type="button" variant="ghost" size="xs" onClick={selectNone}>
                  None
                </Button>
              </div>
            </div>
            <div className="rounded-md border divide-y bg-card max-h-48 overflow-y-auto">
              {keys.map(k => (
                <label key={k.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40">
                  <input
                    type="checkbox"
                    checked={selected.has(k.id)}
                    onChange={() => toggleKey(k.id)}
                    className="size-3.5"
                  />
                  <span className="text-xs flex-1 truncate">{k.label || `Key #${k.id}`}</span>
                  <code className="text-[11px] font-mono text-muted-foreground">{k.maskedKey}</code>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              {error}
            </div>
          )}
          {resultText && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
              {resultText}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={submit.isPending || !modelId.trim() || selected.size === 0}>
              {submit.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
