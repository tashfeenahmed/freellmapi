import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { useI18n } from '@/i18n'

interface MediaModel {
  id: number
  platform: string
  modelId: string
  displayName: string
  modality: 'image' | 'audio'
  enabled: boolean
  quotaLabel: string
  keyCount: number
}
interface MediaData { models: MediaModel[] }

// Shared list view for the Image and Audio dashboard tabs. Mirrors the
// Embeddings tab: a flat list of catalog media models with a per-row enable
// toggle (saved immediately). Rows arrive from the signed catalog via
// catalog-sync, so the list self-populates once a media catalog is applied.
export function MediaModelsView({ modality }: { modality: 'image' | 'audio' }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<MediaData>({
    queryKey: ['media'],
    queryFn: () => apiFetch('/api/media'),
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/media/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['media'] }),
  })

  const models = (data?.models ?? []).filter(m => m.modality === modality)
  const title = modality === 'image' ? t('models.imageTitle') : t('models.audioTitle')
  const description = modality === 'image' ? t('models.imageDesc') : t('models.audioDesc')
  const endpoint = modality === 'image' ? '/v1/images/generations' : '/v1/audio/speech'

  return (
    <div>
      <PageHeader title={title} description={description} divider={false} actions={<ModelsTabs />} />

      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t('models.mediaHint')} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{endpoint}</code>
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : models.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('models.mediaEmpty')}</p>
        ) : (
          <section className="rounded-3xl border bg-card p-5">
            <div className="divide-y">
              {models.map(m => (
                <div key={m.id} className={`flex items-center gap-3 py-2 ${m.enabled ? '' : 'opacity-50'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{m.displayName}</span>
                      <span className="text-xs text-muted-foreground">{m.platform}</span>
                      {m.keyCount === 0 && (
                        <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
                          {t('models.noKey')}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{m.modelId}</div>
                    {m.quotaLabel && <div className="text-[11px] text-muted-foreground/70">{m.quotaLabel}</div>}
                  </div>
                  <Switch
                    checked={m.enabled}
                    onCheckedChange={(c) => toggle.mutate({ id: m.id, enabled: c })}
                  />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
