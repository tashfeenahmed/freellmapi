import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { X } from 'lucide-react'
import type { ApiKey } from '../../../../shared/types'

// #657: relay stations hand out keys that only serve one model group; a key
// scoped here is skipped by the router for every model outside its list. A
// deliberately light editor: a chip list plus a free-text id field. Suggestions
// come only from data the key row already carries (a custom endpoint's
// registered models) — no extra fetching for catalog platforms.
export function ModelScopeDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKey
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // Mounted only while open, so state seeds from the row without reset effects.
  const [ids, setIds] = useState<string[]>(apiKey.modelScope ?? [])
  const [draft, setDraft] = useState('')

  const suggestions = (apiKey.models ?? [])
    .filter(m => m.kind === 'chat' && !ids.includes(m.modelId))
    .map(m => m.modelId)

  const save = useMutation({
    mutationFn: (modelScope: string[] | null) =>
      apiFetch(`/api/keys/${apiKey.id}`, { method: 'PATCH', body: JSON.stringify({ modelScope }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      onOpenChange(false)
    },
  })

  const add = (raw: string) => {
    const id = raw.trim()
    if (!id) return
    setIds(prev => (prev.includes(id) ? prev : [...prev, id]))
    setDraft('')
  }

  const submit = () => {
    // A typed-but-unconfirmed id still counts — losing it on Save is the
    // classic chip-input paper cut.
    const pending = draft.trim()
    const next = pending && !ids.includes(pending) ? [...ids, pending] : ids
    save.mutate(next.length > 0 ? next : null)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <DialogTitle>{t('keys.modelScope')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('keys.modelScopeDesc')}</p>
        <code className="mt-2 block truncate font-mono text-[11px] text-muted-foreground">{apiKey.maskedKey}</code>

        <div className="mt-4 space-y-3">
          {ids.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('keys.modelScopeEmpty')}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {ids.map(id => (
                <span key={id} className="inline-flex min-w-0 items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px]">
                  <span className="max-w-[240px] truncate" title={id}>{id}</span>
                  <button
                    type="button"
                    onClick={() => setIds(prev => prev.filter(x => x !== id))}
                    aria-label={t('common.remove')}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <Input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add(draft)
              }
            }}
            placeholder={t('keys.modelScopeAdd')}
            className="h-8 font-mono text-xs"
          />

          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map(id => (
                <button
                  key={id}
                  type="button"
                  onClick={() => add(id)}
                  className="max-w-[240px] truncate rounded-md border border-dashed px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                  title={id}
                >
                  + {id}
                </button>
              ))}
            </div>
          )}

          {save.isError && (
            <p className="text-xs text-destructive">{(save.error as Error).message}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {(apiKey.modelScope?.length ?? 0) > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mr-auto"
                onClick={() => save.mutate(null)}
                disabled={save.isPending}
              >
                {t('keys.modelScopeClear')}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
