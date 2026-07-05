import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

export function UnifiedKeySection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data, isError } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…'
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  function copy() {
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">{t('keys.unifiedKey')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('keys.unifiedKeyDescBefore')}<code className="font-mono">api_key</code>{t('keys.unifiedKeyDescAfter')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending || isError}
        >
          {t('keys.regenerate')}
        </Button>
      </div>

      {isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('keys.serverUnreachableBefore')}<code className="font-mono">{baseUrl.replace('/v1', '')}</code>{t('keys.serverUnreachableAfter')}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate tabular-nums">
            {showKey ? apiKey : masked}
          </code>
          <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
            {showKey ? t('keys.hideKey') : t('keys.showKey')}
          </Button>
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? t('keys.copiedKey') : t('keys.copyKey')}
          </Button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">{t('keys.baseUrl')}</span>
        <code className="font-mono">{baseUrl}</code>
        <span className="text-muted-foreground">{t('keys.endpointChat')}</span>
        <code className="font-mono">/v1/chat/completions</code>
        <span className="text-muted-foreground">{t('keys.endpointResponses')}</span>
        <code className="font-mono">/v1/responses</code>
        <span className="text-muted-foreground">{t('keys.endpointMessages')}</span>
        <code className="font-mono">/v1/messages <span className="text-muted-foreground">({t('keys.endpointMessagesHint')})</span></code>
        <span className="text-muted-foreground">{t('keys.endpointEmbeddings')}</span>
        <code className="font-mono">/v1/embeddings <span className="text-muted-foreground">({t('keys.endpointEmbeddingsHint')})</span></code>
      </div>
    </section>
  )
}
