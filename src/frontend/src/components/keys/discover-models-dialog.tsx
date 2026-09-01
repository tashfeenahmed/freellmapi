import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { formatContext } from '@/lib/routing'

// #488: relays add and drop models weekly, so keeping a custom endpoint's model
// list current by hand means re-running `curl .../v1/models | jq` every so
// often. Ask the endpoint instead, tick the ones to keep, register them in one
// call. Reads only the user's OWN endpoint with the user's OWN key.

export interface DiscoveredModel {
  id: string
  ownedBy: string | null
  registered: boolean
  /** Approximate context window in tokens when the upstream advertises one. */
  contextWindow?: number
  /** Human-readable price hint ("free", "$1.25/M in $2/M out") when present (#685). */
  priceNote?: string
  /** The server's verdict on whether the note means free — the only thing this
   *  picker badges green, so "$10/M in" can never read as free. */
  isFree?: boolean
  /** True when the upstream advertises image input. */
  vision?: boolean
}

interface DiscoverResponse {
  baseUrl: string
  keyId: number | null
  models: DiscoveredModel[]
  total: number
  registeredCount: number
}

/** How the endpoint is named to the server: a saved key row, or a base URL the
 *  user is still typing (with the key they typed alongside it). */
export interface EndpointRef {
  keyId?: number
  baseUrl?: string
  apiKey?: string
}

export function DiscoverModelsDialog({
  open,
  onOpenChange,
  endpoint,
  onRegistered,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  endpoint: EndpointRef
  onRegistered?: () => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // Only the ids the user ticked. Already-registered ones are rendered checked
  // and disabled without living here, so the list reads as "what this endpoint
  // will serve" while the Add button still counts only what is genuinely new.
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // A query, not a mutation: the dialog is mounted only while open, so the
  // fetch fires on mount and the component needs no reset effect.
  const discover = useQuery<DiscoverResponse>({
    queryKey: ['custom-endpoint-models', endpoint.keyId ?? null, endpoint.baseUrl ?? null],
    queryFn: () => apiFetch('/api/keys/custom/discover-models', {
      method: 'POST',
      body: JSON.stringify(endpoint),
    }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  })
  const models = discover.data?.models ?? []

  const register = useMutation<{ created: number }>({
    meta: { silenceToast: true },
    mutationFn: () => apiFetch('/api/keys/custom', {
      method: 'POST',
      body: JSON.stringify({
        ...(endpoint.keyId === undefined ? { baseUrl: endpoint.baseUrl } : { keyId: endpoint.keyId }),
        ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
        models: [...selected],
      }),
    }),
    onSuccess: (data) => {
      for (const key of ['keys', 'health', 'fallback', 'models']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      toast.success(t('keys.modelsAdded', { count: data.created }))
      onOpenChange(false)
      onRegistered?.()
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

  const selectable = models.filter(m => !m.registered)
  const allSelected = selectable.length > 0 && selectable.every(m => selected.has(m.id))
  const toggleAll = () => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const model of selectable) {
        if (allSelected) next.delete(model.id)
        else next.add(model.id)
      }
      return next
    })
  }

  const newCount = selected.size

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-xl">
        <DialogTitle>{t('keys.discoverTitle')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('keys.discoverHint')}</p>

        {discover.isPending && (
          <p className="mt-4 text-xs text-muted-foreground">{t('common.loading')}</p>
        )}

        {discover.isError && (
          <p className="mt-4 text-xs text-destructive">{(discover.error as Error).message}</p>
        )}

        {discover.isSuccess && models.length === 0 && (
          <p className="mt-4 text-xs text-muted-foreground">{t('keys.discoverEmpty')}</p>
        )}

        {models.length > 0 && (
          <>
            <label className="mt-4 flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={selectable.length === 0}
                onChange={toggleAll}
                className="size-4 accent-primary"
              />
              <span>{t('keys.discoverSelectAll')}</span>
            </label>
            <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-2xl border divide-y">
              {models.map(model => (
                <label
                  key={model.id}
                  className={`flex items-center gap-2 px-3 py-2 text-xs ${model.registered ? 'bg-muted/40' : 'cursor-pointer hover:bg-muted/30'}`}
                >
                  <input
                    type="checkbox"
                    checked={model.registered || selected.has(model.id)}
                    disabled={model.registered}
                    onChange={() => toggle(model.id)}
                    className="size-4 accent-primary"
                  />
                  <code className="min-w-0 flex-1 truncate font-mono" title={model.id}>{model.id}</code>
                  {/* Same chips as the models table, so a discovered row reads
                      the way a registered one will. */}
                  {model.vision && (
                    <span title={t('models.visionTitle')} className="shrink-0 rounded-full bg-cyan-600/15 px-1.5 py-0.5 text-[10px] text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">
                      {t('models.vision')}
                    </span>
                  )}
                  {model.contextWindow !== undefined && model.contextWindow > 0 && (
                    <span title={t('models.ctxTitle')} className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                      {t('models.ctxBadge', { size: formatContext(model.contextWindow) })}
                    </span>
                  )}
                  {model.priceNote && (
                    <span
                      className={`shrink-0 max-w-[140px] truncate rounded-full px-1.5 py-0.5 text-[10px] ${
                        model.isFree
                          ? 'bg-emerald-600/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-400'
                          : 'bg-muted text-muted-foreground'
                      }`}
                      title={model.priceNote}
                    >
                      {model.priceNote}
                    </span>
                  )}
                  {model.ownedBy && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">{model.ownedBy}</span>
                  )}
                  {model.registered && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t('keys.discoverAlreadyAdded')}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </>
        )}

        {register.isError && (
          <p className="mt-3 text-xs text-destructive">{(register.error as Error).message}</p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => register.mutate()}
            disabled={newCount === 0 || register.isPending}
          >
            {newCount === 1 ? t('keys.addModel') : t('keys.addModels', { count: newCount })}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
