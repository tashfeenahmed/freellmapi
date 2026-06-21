import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { CopyButton } from '@/components/copy-button'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { Switch } from '@/components/ui/switch'
import { apiBaseUrl, ApiUsageBlock } from '@/components/api-usage'
import type { MediaModel } from '@/components/media-models'

// One generative-media model's page: every provider that serves this logical
// model (failover routes across them), plus a ready-to-run snippet. Mirrors the
// chat ModelDetailPage for the image and audio modalities.
export default function MediaDetailPage({ modality }: { modality: 'image' | 'audio' }) {
  const { t } = useI18n()
  const { id } = useParams<{ id: string }>()
  const label = id ? decodeURIComponent(id) : ''
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<{ models: MediaModel[] }>({
    queryKey: ['media'],
    queryFn: () => apiFetch('/api/media'),
  })
  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const toggle = useMutation({
    mutationFn: (vars: { mediaId: number; enabled: boolean }) =>
      apiFetch(`/api/media/${vars.mediaId}`, { method: 'PUT', body: JSON.stringify({ enabled: vars.enabled }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['media'] }),
  })

  const members = (data?.models ?? []).filter(m => m.modality === modality && m.displayName === label)
  const quota = members.map(m => m.quotaLabel).find(Boolean)

  // A ready-to-run request. `model: "auto"` also works (tries every provider);
  // here we pin the first provider's id as a concrete example.
  const exampleModel = members[0]?.modelId ?? 'auto'
  const base = apiBaseUrl()
  const key = keyData?.apiKey || 'YOUR_API_KEY'
  const snippet = modality === 'image'
    ? `curl ${base}/images/generations \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleModel}",
    "prompt": "a red cat"
  }'`
    : `curl ${base}/audio/speech \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleModel}",
    "input": "Hello world"
  }' --output speech.mp3`

  return (
    <div>
      <PageHeader title={label || t('models.providersHeading')} description={t('models.providersHeading')} divider={false} actions={<ModelsTabs />} />

      <div className="space-y-6">
        <Link to={`/models/${modality}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" />{t('models.backToModels')}
        </Link>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : members.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('models.modelNotFound')}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground">{t('models.providerCount', { count: members.length })}</span>
              {quota && <span className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground tabular-nums">{quota}</span>}
            </div>

            {/* Providers serving this model — pin one with its id, or toggle it. */}
            <div className="rounded-2xl border bg-card p-4">
              <h2 className="text-sm font-medium">{t('models.providerIdsHeading')}</h2>
              <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{t('models.providerIdsHint')}</p>
              <div className="space-y-1.5">
                {members.map(m => (
                  <div key={m.id} className={`flex items-center gap-2 text-xs ${m.enabled ? '' : 'opacity-50'}`}>
                    <span className="w-28 shrink-0 text-muted-foreground">{m.platform}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{m.modelId}</code>
                    {m.keyCount === 0 && (
                      <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">{t('models.noKey')}</span>
                    )}
                    <CopyButton text={m.modelId} />
                    <Switch checked={m.enabled} onCheckedChange={(c) => toggle.mutate({ mediaId: m.id, enabled: c })} />
                  </div>
                ))}
              </div>
            </div>

            {/* Ways to use the API */}
            <ApiUsageBlock snippet={snippet} />
          </>
        )}
      </div>
    </div>
  )
}
