import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { formatContext, type FallbackEntry } from '@/lib/routing'
import { scopeCandidates } from '@/lib/model-scope-selection'
import { X } from 'lucide-react'
import type { ApiKey } from '../../../../shared/types'

/** Re-open the post-add model picker for an existing key. The catalog is the
 *  source for fixed providers; custom endpoints use their registered models. */
export function EditModelsDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKey
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: catalog = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
    enabled: apiKey.platform !== 'custom',
  })

  const candidates = apiKey.platform === 'custom'
    ? (apiKey.models ?? [])
      .filter(model => model.kind === 'chat')
      .map(model => ({
        modelId: model.modelId,
        displayName: model.displayName || model.modelId,
        sizeLabel: null,
        contextWindow: null,
      }))
    : scopeCandidates(catalog, apiKey.platform)

  const allIds = candidates.map(model => model.modelId)
  // Keep "all" as a mode rather than snapshotting every current id: the
  // catalog query resolves after mount, and a stored full list would go stale.
  const [allMode, setAllMode] = useState(apiKey.modelScope === null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(apiKey.modelScope ?? []))

  const syncCatalog = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => apiFetch('/api/premium/sync', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      toast.success(t('keys.editModelsSynced'))
    },
    onError: error => toast.error((error as Error).message),
  })

  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: (modelScope: string[] | null) =>
      apiFetch(`/api/keys/${apiKey.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ modelScope }),
      }),
    onSuccess: (_data, modelScope) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      toast.success(t(
        modelScope === null
          ? 'keys.modelPicker.allSaved'
          : modelScope.length === 1
            ? 'keys.modelPicker.scopedOne'
            : 'keys.modelPicker.scopedOther',
        ...(modelScope === null ? [] : [{ count: modelScope.length }]),
      ))
      onOpenChange(false)
    },
  })

  const toggle = (id: string) => {
    if (allMode) {
      setAllMode(false)
      const next = new Set(allIds)
      next.delete(id)
      setSelected(next)
      return
    }
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isSelected = (id: string) => allMode || selected.has(id)
  const allSelected = allIds.length > 0 && allIds.every(isSelected)
  const selectedCount = allMode ? allIds.length : selected.size
  const toggleAll = () => {
    setAllMode(false)
    setSelected(allSelected ? new Set() : new Set(allIds))
  }
  const submit = () => save.mutate(allSelected ? null : [...selected])

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('keys.editModels')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        {apiKey.platform === 'custom' ? (
          <p className="text-xs text-muted-foreground">{t('keys.editModelsCustomHint')}</p>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <p className="max-w-prose text-xs text-muted-foreground">{t('keys.editModelsHint')}</p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => syncCatalog.mutate()}
              disabled={syncCatalog.isPending}
            >
              {syncCatalog.isPending ? t('keys.editModelsSyncing') : t('keys.editModelsSync')}
            </Button>
          </div>
        )}

        {apiKey.platform !== 'custom' && catalog.length === 0 && (
          <p className="mt-4 text-xs text-muted-foreground">{t('common.loading')}</p>
        )}

        {candidates.length > 0 && (
          <>
            <label className="mt-4 flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="size-4 accent-primary"
              />
              <span>{t('keys.discoverSelectAll')}</span>
              <span className="ml-auto font-normal text-muted-foreground tabular-nums">
                {t('keys.modelPicker.count', { selected: selectedCount, total: allIds.length })}
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
                    checked={isSelected(model.modelId)}
                    onChange={() => toggle(model.modelId)}
                    className="size-4 accent-primary"
                  />
                  <span className="min-w-0 flex-1 truncate" title={model.modelId}>
                    {model.displayName}
                  </span>
                  {model.sizeLabel && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {model.sizeLabel}
                    </span>
                  )}
                  {model.contextWindow !== null && model.contextWindow > 0 && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                      {t('models.ctxBadge', { size: formatContext(model.contextWindow) })}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </>
        )}

        {save.isError && (
          <p className="mt-3 text-xs text-destructive">{(save.error as Error).message}</p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={(!allMode && selected.size === 0) || save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
