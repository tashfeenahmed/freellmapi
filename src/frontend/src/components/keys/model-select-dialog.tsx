import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { formatContext } from '@/lib/routing'
import { resolveScopeUpdate, type ScopeCandidate } from '@/lib/model-scope-selection'

// Post-add model picker. A key pasted for a platform with a large catalog is
// assumed to serve all of it (#657: modelScope null), which is wrong for relay
// keys sold per model group — and the symptom is a run of 401s at routing time
// rather than anything the Keys page shows. So once, right after the add, show
// what this key is about to be asked to serve.
//
// Everything is ticked on arrival because "all" is both the current behaviour
// and the right default; confirming untouched therefore sends NO request at
// all (see resolveScopeUpdate — a stored full list would freeze the key at
// today's catalog). Only a genuine subset costs one PATCH. Dismissing costs
// nothing: the key is already added and already works.
//
// The list is handed in by the add flow, which reads it from the ['fallback']
// model list the dashboard already holds — this dialog fetches nothing.
export function ModelSelectDialog({
  keyId,
  platformLabel,
  candidates,
  onOpenChange,
}: {
  keyId: number
  /** Human-readable provider name for the subtitle, e.g. "Groq". */
  platformLabel: string
  candidates: ScopeCandidate[]
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const allIds = candidates.map(c => c.modelId)
  // Mounted only while open, so the all-ticked default seeds from props
  // without a reset effect.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds))

  const save = useMutation({
    // The failure is shown inline, right under the list it belongs to.
    meta: { silenceToast: true },
    mutationFn: (modelScope: string[]) =>
      apiFetch(`/api/keys/${keyId}`, { method: 'PATCH', body: JSON.stringify({ modelScope }) }),
    onSuccess: (_data, modelScope) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      // Singular/plural as separate keys, the way keys.modelScopeBadgeOne/Other
      // already do it — this i18n layer has no plural rules of its own.
      toast.success(t(
        modelScope.length === 1 ? 'keys.modelPicker.scopedOne' : 'keys.modelPicker.scopedOther',
        { count: modelScope.length },
      ))
      onOpenChange(false)
    },
  })

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = allIds.length > 0 && allIds.every(id => selected.has(id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allIds))

  const confirm = () => {
    const update = resolveScopeUpdate(allIds, selected)
    // Untouched (or somehow empty) = the key keeps the null scope it was added
    // with. Closing is the whole action; there is nothing to save.
    if (!update.patch) {
      onOpenChange(false)
      return
    }
    save.mutate(update.modelScope)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-xl">
        <DialogTitle>{t('keys.modelPicker.title')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('keys.modelPicker.hint', { provider: platformLabel })}
        </p>

        <label className="mt-4 flex items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="size-4 accent-primary"
          />
          <span>{t('keys.discoverSelectAll')}</span>
          <span className="ml-auto font-normal text-muted-foreground tabular-nums">
            {t('keys.modelPicker.count', { selected: selected.size, total: allIds.length })}
          </span>
        </label>

        <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-2xl border divide-y">
          {candidates.map(model => (
            <label
              key={model.modelId}
              className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-muted/30"
            >
              <input
                type="checkbox"
                checked={selected.has(model.modelId)}
                onChange={() => toggle(model.modelId)}
                className="size-4 accent-primary"
              />
              <span className="min-w-0 flex-1 truncate" title={model.modelId}>
                {model.displayName}
              </span>
              {/* Same badge vocabulary as the models table and the discover
                  dialog, so a row here reads the way it will there. */}
              {model.sizeLabel && (
                <span
                  title={t('models.sizeLabel')}
                  className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {model.sizeLabel}
                </span>
              )}
              {model.contextWindow !== null && model.contextWindow > 0 && (
                <span
                  title={t('models.ctxTitle')}
                  className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums"
                >
                  {t('models.ctxBadge', { size: formatContext(model.contextWindow) })}
                </span>
              )}
            </label>
          ))}
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">
          {allSelected ? t('keys.modelPicker.allNote') : t('keys.modelPicker.subsetNote')}
        </p>

        {save.isError && (
          <p className="mt-2 text-xs text-destructive">{(save.error as Error).message}</p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {t('keys.modelPicker.skip')}
          </Button>
          <Button size="sm" onClick={confirm} disabled={selected.size === 0 || save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
