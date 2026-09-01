import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AudioLines, Clapperboard, Image as ImageIcon, Mic } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { ConfirmButton } from '@/components/confirm-button'
import { EmptyState } from '@/components/empty-state'
import { CardSkeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { UsageSummaryCard } from '@/components/usage-summary-card'
import { useI18n } from '@/i18n'

export interface MediaModel {
  id: number
  platform: string
  modelId: string
  displayName: string
  modality: 'image' | 'video' | 'audio' | 'transcription'
  enabled: boolean
  quotaLabel: string
  keyCount: number
  isCustom?: boolean
}
interface MediaData { models: MediaModel[] }

interface MediaUsage {
  modality: 'image' | 'video' | 'audio' | 'transcription'
  models: {
    id: number
    platform: string
    modelId: string
    displayName: string
    quotaLabel: string | null
    requestsToday: number
    requestsMonth: number
  }[]
  totalRequestsToday: number
  totalRequestsMonth: number
}

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

// One consolidated logical-model card: providers underneath in failover order
// (rows arrive from the API already sorted by priority), each with an enable
// toggle saved immediately.
function MediaGroupCard({
  group: g,
  detailBase,
  onToggle,
  onDeleteCustom,
  deletePending,
}: {
  group: MediaGroup
  detailBase: string
  onToggle: (id: number, enabled: boolean) => void
  onDeleteCustom: (id: number) => void
  deletePending: boolean
}) {
  const { t } = useI18n()
  const anyEnabled = g.members.some(m => m.enabled)
  const quota = g.members.map(m => m.quotaLabel).find(Boolean)
  return (
    <section className={`rounded-3xl border bg-card p-5 ${anyEnabled ? '' : 'opacity-60'}`}>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <Link to={`${detailBase}/${g.slug}`} className="text-sm font-medium hover:underline">{g.label}</Link>
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
              onCheckedChange={(c) => onToggle(m.id, c)}
            />
            {m.isCustom && (
              <ConfirmButton
                className="text-muted-foreground hover:text-destructive"
                onConfirm={() => onDeleteCustom(m.id)}
                disabled={deletePending}
              >
                {t('common.remove')}
              </ConfirmButton>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// Shared list view for the Image, Video, and Audio dashboard tabs. Mirrors the chat
// Models page: media models are consolidated into one logical-model group per
// name (with a "N providers" badge), each linking to its own detail page, and a
// per-provider enable toggle (saved immediately). Rows arrive from the signed
// catalog via catalog-sync, so the list self-populates once a media catalog is
// applied. The Audio tab carries both directions of the modality: audio out
// (text to speech, /v1/audio/speech) and audio in (speech to text,
// /v1/audio/transcriptions) as two sections of one page.
export function MediaModelsView({ modality }: { modality: 'image' | 'video' | 'audio' }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<MediaData>({
    queryKey: ['media'],
    queryFn: () => apiFetch('/api/media'),
  })

  const { data: usage } = useQuery<MediaUsage>({
    queryKey: ['media', 'usage', modality],
    queryFn: () => apiFetch(`/api/media/usage?modality=${modality}`),
    refetchInterval: 30_000,
  })

  // The Audio tab carries both directions of the modality, so the STT section
  // gets its own usage summary (the endpoint accepts modality=transcription).
  const { data: sttUsage } = useQuery<MediaUsage>({
    queryKey: ['media', 'usage', 'transcription'],
    queryFn: () => apiFetch('/api/media/usage?modality=transcription'),
    enabled: modality === 'audio',
    refetchInterval: 30_000,
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/media/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['media'] }),
  })

  const deleteCustom = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/media/custom/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['media'] }),
  })

  const models = data?.models ?? []
  const groups = groupMedia(models.filter(m => m.modality === modality))
  const sttGroups = groupMedia(models.filter(m => m.modality === 'transcription'))
  // Every models tab shares one title; the tab bar above says which set you are
  // looking at, so repeating "Image"/"Audio" here just competed with it.
  const title = t('models.title')
  const description = modality === 'image'
    ? t('models.imageDesc')
    : modality === 'video'
      ? t('models.videoDesc')
      : t('models.audioDesc')
  const endpoint = modality === 'image'
    ? '/v1/images/generations'
    : modality === 'video'
      ? '/v1/videos/generations'
      : '/v1/audio/speech'

  const renderGroups = (gs: MediaGroup[], detailBase: string) => gs.map(g => (
    <MediaGroupCard
      key={g.slug}
      group={g}
      detailBase={detailBase}
      onToggle={(id, enabled) => toggle.mutate({ id, enabled })}
      onDeleteCustom={(id) => deleteCustom.mutate(id)}
      deletePending={deleteCustom.isPending}
    />
  ))

  return (
    <div>
      <PageHeader title={title} description={description} divider={false} actions={<ModelsTabs />} />

      <div className="space-y-4">
        {modality === 'audio' && <h2 className="text-sm font-medium">{t('models.ttsHeading')}</h2>}
        <p className="text-xs text-muted-foreground">
          {t('models.mediaHint')} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{endpoint}</code>
        </p>

        {usage && usage.models.length > 0 && (
          <UsageSummaryCard
            unit="requests"
            total={usage.totalRequestsMonth}
            requestsToday={usage.totalRequestsToday}
            rows={usage.models.map(m => ({
              label: m.displayName,
              platform: m.platform,
              // Two providers can serve the same model name (FLUX.1 on both
              // nvidia and cloudflare), so name the provider to tell them apart.
              quotaLabel: [m.platform, m.quotaLabel].filter(Boolean).join(' · '),
              amount: m.requestsMonth,
              requestsToday: m.requestsToday,
            }))}
          />
        )}

        {isLoading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={modality === 'image' ? ImageIcon : modality === 'video' ? Clapperboard : AudioLines}
            title={t('models.mediaEmpty')}
          />
        ) : (
          renderGroups(groups, `/models/${modality}`)
        )}
      </div>

      {modality === 'audio' && (
        <div className="mt-10 space-y-4">
          <h2 className="text-sm font-medium">{t('models.sttHeading')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('models.sttHint')} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">/v1/audio/transcriptions</code>
          </p>

          {sttUsage && sttUsage.models.length > 0 && (
            <UsageSummaryCard
              rows={sttUsage.models.map(m => ({
                label: m.displayName,
                platform: m.platform,
                quotaLabel: [m.platform, m.quotaLabel].filter(Boolean).join(' · '),
                amount: m.requestsMonth,
                requestsToday: m.requestsToday,
              }))}
              total={sttUsage.totalRequestsMonth}
              requestsToday={sttUsage.totalRequestsToday}
              unit="requests"
            />
          )}

          {isLoading ? (
            <CardSkeleton />
          ) : sttGroups.length === 0 ? (
            <EmptyState icon={Mic} title={t('models.sttEmpty')} />
          ) : (
            renderGroups(sttGroups, '/models/transcription')
          )}
        </div>
      )}
    </div>
  )
}
