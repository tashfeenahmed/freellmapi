import { CopyButton } from '@/components/copy-button'
import { useI18n } from '@/i18n'

// The /v1 base URL for ready-to-run snippets, derived the same way as the chat
// model page + Keys page: the dev server port in DEV, the page origin in a
// packaged/hosted build.
export function apiBaseUrl(): string {
  return import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`
}

// A copy-able "ways to use the API" code block, matching the chat detail page's
// snippet card so every modality's detail page looks the same.
export function ApiUsageBlock({ snippet }: { snippet: string }) {
  const { t } = useI18n()
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <CopyButton text={snippet} className="size-7 shrink-0" label={t('common.copy')} />
        <span className="text-xs font-medium">{t('models.codeSnippetHeading')}</span>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[11px] leading-relaxed"><code className="font-mono">{snippet}</code></pre>
    </div>
  )
}
