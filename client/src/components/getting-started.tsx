import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Check, Copy, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { apiBaseUrl } from '@/components/api-usage'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

const DISMISS_KEY = 'freellmapi.setup.dismissed'
const CONNECT_KEY = 'freellmapi.setup.connected'

function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}
function writeFlag(key: string) {
  try { localStorage.setItem(key, '1') } catch { /* ignore */ }
}

// First-run checklist on the Models landing page. A fresh install lands on an
// empty routing table with no hint of what to do; this walks the three steps
// that make the router actually useful (key -> test -> connect) and disappears
// once the install is clearly set up (has keys and has served a request), or
// when dismissed.
export function GettingStarted() {
  const { t } = useI18n()
  const [dismissed, setDismissed] = useState(() => readFlag(DISMISS_KEY))
  const [connected, setConnected] = useState(() => readFlag(CONNECT_KEY))

  const { data: keys } = useQuery<unknown[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })
  const { data: summary } = useQuery<{ totalRequests?: number }>({
    queryKey: ['setup-summary'],
    queryFn: () => apiFetch('/api/analytics/summary?range=30d'),
    staleTime: 30_000,
  })
  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  // Wait for real data before deciding: rendering on undefined would flash the
  // checklist at every established install for a moment on each visit.
  if (dismissed || !keys || !summary) return null

  const hasKeys = keys.length > 0
  const hasRequest = (summary.totalRequests ?? 0) > 0
  if (hasKeys && hasRequest) return null

  const doneCount = [hasKeys, hasRequest, connected].filter(Boolean).length

  function copyValue(value: string, message: string) {
    void navigator.clipboard?.writeText(value)
    toast.success(message)
    setConnected(true)
    writeFlag(CONNECT_KEY)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">{t('setup.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('setup.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">{t('setup.progress', { done: doneCount, total: 3 })}</span>
          <button
            type="button"
            aria-label={t('common.dismiss')}
            onClick={() => { setDismissed(true); writeFlag(DISMISS_KEY) }}
            className="rounded-md p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <ol className="mt-4 space-y-1">
        <Step
          index={1}
          done={hasKeys}
          title={t('setup.step1Title')}
          description={t('setup.step1Desc')}
          action={
            <Link to="/keys">
              <Button variant="outline" size="sm">
                {t('setup.step1Cta')}
                <ArrowRight data-icon="inline-end" className="size-3.5" />
              </Button>
            </Link>
          }
        />
        <Step
          index={2}
          done={hasRequest}
          title={t('setup.step2Title')}
          description={t('setup.step2Desc')}
          action={
            <Link to="/playground">
              <Button variant="outline" size="sm">
                {t('setup.step2Cta')}
                <ArrowRight data-icon="inline-end" className="size-3.5" />
              </Button>
            </Link>
          }
        />
        <Step
          index={3}
          done={connected}
          title={t('setup.step3Title')}
          description={t('setup.step3Desc')}
          action={
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!keyData?.apiKey}
                onClick={() => keyData?.apiKey && copyValue(keyData.apiKey, t('setup.copiedKey'))}
              >
                <Copy data-icon="inline-start" className="size-3.5" />
                {t('setup.copyKey')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyValue(apiBaseUrl(), t('setup.copiedUrl'))}
              >
                <Copy data-icon="inline-start" className="size-3.5" />
                {t('setup.copyUrl')}
              </Button>
            </div>
          }
        />
      </ol>
    </section>
  )
}

function Step({
  index,
  done,
  title,
  description,
  action,
}: {
  index: number
  done: boolean
  title: string
  description: string
  action: ReactNode
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-2 py-2.5 sm:flex-nowrap">
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium tabular-nums ${
          done ? 'bg-emerald-600 text-white dark:bg-emerald-500' : 'border text-muted-foreground'
        }`}
      >
        {done ? <Check className="size-3" /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm ${done ? 'text-muted-foreground line-through decoration-muted-foreground/40' : 'font-medium'}`}>{title}</p>
        {!done && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {!done && <div className="ml-8 shrink-0 sm:ml-0">{action}</div>}
    </li>
  )
}
