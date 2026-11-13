import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { useI18n } from '@/i18n'

const EXAMPLE = `curl http://localhost:3001/v1/chat/completions \\
  -H "Authorization: Bearer $FREELLMAPI_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "iterative-critique",
    "messages": [{"role": "user", "content": "Your question"}],
    "iterative_critique": {"max_rounds": 3}
  }'`

// Info-only: the loop needs no saved settings; every option is per request.
export default function IterativeCritiquePage() {
  const { t } = useI18n()
  return (
    <div>
      <PageHeader
        title={t('iterativeCritique.title')}
        description={t('iterativeCritique.description')}
        divider={false}
        actions={<ModelsTabs />}
      />
      <section className="space-y-3">
        <h2 className="text-sm font-medium">{t('iterativeCritique.howToUse')}</h2>
        <p className="text-xs text-muted-foreground">{t('iterativeCritique.howToUseHelp')}</p>
        <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">{EXAMPLE}</pre>
      </section>
    </div>
  )
}
