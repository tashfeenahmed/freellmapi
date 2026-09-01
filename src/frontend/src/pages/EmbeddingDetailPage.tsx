import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { CopyButton } from '@/components/copy-button'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { apiBaseUrl, ApiUsageBlock } from '@/components/api-usage'

interface ProviderEntry {
  id: number
  platform: string
  modelId: string
  displayName: string
  priority: number
  enabled: boolean
  quotaLabel: string
  keyCount: number
}
interface Family {
  family: string
  dimensions: number
  maxInputTokens: number | null
  isDefault: boolean
  providers: ProviderEntry[]
}
interface EmbeddingsData { defaultFamily: string; families: Family[] }

// One embedding family's page: the providers serving it (failover routes across
// them, same vector space) + a ready-to-run snippet. The family list / routing
// management stays on the Embeddings tab; this mirrors the chat model page.
export default function EmbeddingDetailPage() {
  const { t } = useI18n()
  const { id } = useParams<{ id: string }>()
  const family = id ? decodeURIComponent(id) : ''

  const { data, isLoading } = useQuery<EmbeddingsData>({
    queryKey: ['embeddings'],
    queryFn: () => apiFetch('/api/embeddings'),
  })
  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const fam = (data?.families ?? []).find(f => f.family === family)
  const base = apiBaseUrl()
  const key = keyData?.apiKey || 'YOUR_API_KEY'
  const snippet = `curl ${base}/embeddings \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${family}",
    "input": "hello world"
  }'`

  return (
    <div>
      <PageHeader title={family || t('models.providersHeading')} description={t('models.providersHeading')} divider={false} actions={<ModelsTabs />} />

      <div className="space-y-6">
        <Link to="/models/embeddings" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" />{t('models.backToModels')}
        </Link>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : !fam ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('models.modelNotFound')}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground">{t('models.providerCount', { count: fam.providers.length })}</span>
              <span className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground tabular-nums">{fam.dimensions}d</span>
            </div>

            <div className="rounded-2xl border bg-card p-4">
              <h2 className="text-sm font-medium">{t('models.providerIdsHeading')}</h2>
              <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{t('models.providerIdsHint')}</p>
              <div className="space-y-1.5">
                {fam.providers.map(p => (
                  <div key={p.id} className={`flex items-center gap-2 text-xs ${p.enabled ? '' : 'opacity-50'}`}>
                    <span className="w-28 shrink-0 text-muted-foreground">{p.platform}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{p.modelId}</code>
                    {p.keyCount === 0 && (
                      <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">{t('models.noKey')}</span>
                    )}
                    <CopyButton text={p.modelId} label={t('models.copyModelName')} />
                  </div>
                ))}
              </div>
            </div>

            <ApiUsageBlock snippet={snippet} />
          </>
        )}
      </div>
    </div>
  )
}
