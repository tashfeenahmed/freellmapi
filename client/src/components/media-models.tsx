import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { useI18n } from '@/i18n'

export interface MediaModel {
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

export interface MediaGroup {
  label: string
  slug: string
  members: MediaModel[]
}

// Consolidate media rows into logical models — the same idea the chat Models page
// uses (one logical model, several providers underneath). Group by displayName so
// e.g. "FLUX.1 [schnell]" served by nvidia + cloudflare + siliconflow is one row.
export function groupMedia(models: MediaModel[]): MediaGroup[] {
  const map = new Map<string, MediaModel[]>()
  for (const m of models) {
    const arr = map.get(m.displayName)
    if (arr) arr.push(m)
    else map.set(m.displayName, [m])
  }
  return [...map.entries()]
    .map(([label, members]) => ({ label, slug: encodeURIComponent(label), members }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// Shared list view for the Image and Audio dashboard tabs. Mirrors the chat
// Models page: media models are consolidated into one logical-model group per
// name (with a "N providers" badge), each linking to its own detail page, and a
// per-provider enable toggle (saved immediately). Rows arrive from the signed
// catalog via catalog-sync, so the list self-populates once a media catalog is
// applied.
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

  const groups = groupMedia((data?.models ?? []).filter(m => m.modality === modality))
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
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('models.mediaEmpty')}</p>
        ) : (
          groups.map(g => {
            const anyEnabled = g.members.some(m => m.enabled)
            const quota = g.members.map(m => m.quotaLabel).find(Boolean)
            return (
              <section key={g.slug} className={`rounded-3xl border bg-card p-5 ${anyEnabled ? '' : 'opacity-60'}`}>
                <div className="mb-3 flex items-center gap-2 flex-wrap">
                  <Link to={`/models/${modality}/${g.slug}`} className="text-sm font-medium hover:underline">{g.label}</Link>
                  {g.members.length > 1 ? (
                    <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground">
                      {t('models.providerCount', { count: g.members.length })}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">{g.members[0].platform}</span>
                  )}
                  {quota && (
                    <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground tabular-nums">{quota}</span>
                  )}
                </div>

                <div className="divide-y">
                  {g.members.map(m => (
                    <div key={m.id} className={`flex items-center gap-3 py-2 ${m.enabled ? '' : 'opacity-50'}`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{m.platform}</span>
                          {m.keyCount === 0 && (
                            <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
                              {t('models.noKey')}
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">{m.modelId}</div>
                      </div>
                      <Switch
                        checked={m.enabled}
                        onCheckedChange={(c) => toggle.mutate({ id: m.id, enabled: c })}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}
