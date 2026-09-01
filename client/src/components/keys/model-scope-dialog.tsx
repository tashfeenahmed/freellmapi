import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { X } from 'lucide-react'
import type { ApiKey } from '../../../../shared/types'
import type { FallbackEntry } from '@/lib/routing'
import { scopeCandidates } from '@/lib/model-scope-selection'

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
  const [catalogTouched, setCatalogTouched] = useState(false)
  const [draft, setDraft] = useState('')
  const [providerRpmLimit, setProviderRpmLimit] = useState(apiKey.providerRpmLimit?.toString() ?? '')
  const [providerRpdLimit, setProviderRpdLimit] = useState(apiKey.providerRpdLimit?.toString() ?? '')
  const [providerTpdLimit, setProviderTpdLimit] = useState(apiKey.providerTpdLimit?.toString() ?? '')

  const { data: fallback = [], isLoading: catalogLoading, isError: catalogError } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
    enabled: apiKey.platform !== 'custom',
  })
  const catalogCandidates = useMemo(
    () => scopeCandidates(fallback, apiKey.platform),
    [fallback, apiKey.platform],
  )
  const liveCandidates = useMemo(() => {
    if (apiKey.platform === 'custom' || catalogCandidates.length > 0) return []
    const seen = new Set<string>()
    return (apiKey.models ?? [])
      .filter(model => model.kind === 'chat' && model.modelId && !seen.has(model.modelId) && seen.add(model.modelId))
      .map(model => ({ modelId: model.modelId, displayName: model.displayName || model.modelId }))
  }, [apiKey.models, apiKey.platform, catalogCandidates.length])
  // The curated FreeLLMAPI catalogue is authoritative. Live discovery is used
  // only when this provider has no catalogue rows at all (for example a newly
  // added SambaNova-compatible endpoint).
  const providerCandidates = catalogCandidates.length > 0 ? catalogCandidates : liveCandidates
  const catalogIds = providerCandidates.map(candidate => candidate.modelId)
  const catalogReady = apiKey.platform === 'custom' || (!catalogLoading && !catalogError)
  const selectedCatalogIds = !catalogTouched && (apiKey.modelScope === null || apiKey.modelScope === undefined)
    ? catalogIds
    : catalogIds.filter(id => ids.includes(id))

  const suggestions = (apiKey.models ?? [])
    .filter(m => m.kind === 'chat' && !ids.includes(m.modelId))
    .map(m => m.modelId)

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch(`/api/keys/${apiKey.id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
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
    if (!catalogReady) return
    // A typed-but-unconfirmed id still counts — losing it on Save is the
    // classic chip-input paper cut.
    const pending = draft.trim()
    const next = pending && !ids.includes(pending) ? [...ids, pending] : ids
    const modelScope = apiKey.platform === 'custom'
      ? (next.length > 0 ? next : null)
      : (selectedCatalogIds.length === catalogIds.length ? null : selectedCatalogIds)
    save.mutate({
      modelScope,
      providerRpmLimit: providerRpmLimit === '' ? null : Number(providerRpmLimit),
      providerRpdLimit: providerRpdLimit === '' ? null : Number(providerRpdLimit),
      providerTpdLimit: providerTpdLimit === '' ? null : Number(providerTpdLimit),
    })
  }

  const toggleCatalogModel = (modelId: string) => {
    const selected = new Set(selectedCatalogIds)
    if (selected.has(modelId)) selected.delete(modelId)
    else selected.add(modelId)
    setCatalogTouched(true)
    setIds([...selected])
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <DialogTitle>{t('keys.modelScope')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('keys.modelScopeDesc')}</p>
        <code className="mt-2 block truncate font-mono text-[11px] text-muted-foreground">{apiKey.maskedKey}</code>

        <div className="mt-4 space-y-3">
          {apiKey.platform !== 'custom' && catalogLoading ? (
            <p className="text-xs text-muted-foreground">{t('auth.loading')}</p>
          ) : apiKey.platform !== 'custom' && catalogError ? (
            <p className="text-xs text-destructive">{t('keys.catalogLoadFailed')}</p>
          ) : apiKey.platform !== 'custom' && providerCandidates.length > 0 ? (
            <>
            {catalogCandidates.length === 0 && (
              <p className="text-[11px] text-muted-foreground">{t('keys.liveModelsFallback')}</p>
            )}
            <div className="max-h-[42vh] overflow-y-auto rounded-2xl border divide-y">
              {providerCandidates.map(model => (
                <label key={model.modelId} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-muted/30">
                  <input
                    type="checkbox"
                    checked={selectedCatalogIds.includes(model.modelId)}
                    onChange={() => toggleCatalogModel(model.modelId)}
                    className="size-4 accent-primary"
                  />
                  <span className="min-w-0 flex-1 truncate" title={model.modelId}>{model.displayName}</span>
                  <code className="max-w-[190px] truncate text-[10px] text-muted-foreground">{model.modelId}</code>
                </label>
              ))}
            </div>
            </>
          ) : ids.length === 0 ? (
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

          {apiKey.platform === 'custom' && <Input
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
          />}

          {apiKey.platform === 'custom' && suggestions.length > 0 && (
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

          <div className="rounded-xl border p-3">
            <p className="text-xs font-medium">{t('keys.providerAccountLimits')}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t('keys.providerAccountLimitsHint')}</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                ['RPM', providerRpmLimit, setProviderRpmLimit],
                ['RPD', providerRpdLimit, setProviderRpdLimit],
                ['TPD', providerTpdLimit, setProviderTpdLimit],
              ].map(([label, value, setter]) => (
                <label key={label as string} className="text-[11px] text-muted-foreground">
                  {label as string}
                  <Input type="number" min="0" step="1" value={value as string} onChange={event => (setter as (value: string) => void)(event.target.value)} className="mt-1 h-8 text-xs" />
                </label>
              ))}
            </div>
          </div>

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
                onClick={() => save.mutate({ modelScope: null })}
                disabled={save.isPending}
              >
                {t('keys.modelScopeClear')}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={save.isPending || !catalogReady || (apiKey.platform !== 'custom' && catalogIds.length > 0 && selectedCatalogIds.length === 0)}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
