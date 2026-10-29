import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, CircleAlert, FlaskConical, Loader2, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import type { Model } from '@freellmapi/shared/types'
import type { SearchEngine } from '@/lib/search'
import type { DecisionModel } from '@/lib/decision'
import { MODEL_TEST_MIN_INTERVAL_MS, nowMs } from '@/lib/test-models'

// Fire one real "ping" at a model/engine through its own test endpoint and show
// pass/fail with latency. Lived on the Providers page before that page was folded
// into Keys; the dialog lists everything one provider offers — chat models,
// search engines and decision models — so the Keys page can stay key-centric and
// still answer "does this provider actually work".

type Kind = 'chat' | 'search' | 'decision'

interface TestState {
  loading: boolean
  lastTestedAt?: number
  result?: { success: boolean; latencyMs: number; error?: string }
}

interface Item {
  kind: Kind
  id: number
  label: string
  sublabel: string
  enabled: boolean
  keyCount: number
}

export interface TestModelsDialogProps {
  /** Platform id, e.g. 'groq' or 'custom'. */
  platform: string
  /** For custom endpoints: only the models bound to this key. */
  keyId?: number | null
  /** Heading shown next to the dialog title (provider name or key label). */
  label: string
  onOpenChange: (open: boolean) => void
}

export function TestModelsDialog({ platform, keyId, label, onOpenChange }: TestModelsDialogProps) {
  const { t } = useI18n()
  const { data: models = [], isLoading: modelsLoading } = useQuery<Model[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })
  const { data: engines = [], isLoading: enginesLoading } = useQuery<SearchEngine[]>({
    queryKey: ['search-engines'],
    queryFn: () => apiFetch('/api/search/engines'),
  })
  const { data: decisions = [], isLoading: decisionsLoading } = useQuery<DecisionModel[]>({
    queryKey: ['decision-models'],
    queryFn: () => apiFetch('/api/decisions/models'),
  })

  const isLoading = modelsLoading || enginesLoading || decisionsLoading

  const chatItems: Item[] = models
    .filter(m => m.platform === platform && (keyId == null || m.keyId === keyId))
    .sort((a, b) => a.intelligenceRank - b.intelligenceRank || a.displayName.localeCompare(b.displayName))
    .map(m => ({ kind: 'chat', id: m.id, label: m.displayName, sublabel: m.modelId, enabled: m.enabled, keyCount: 1 }))

  const searchItems: Item[] = engines
    .filter(e => e.platform === platform)
    .map(e => ({ kind: 'search', id: e.id, label: e.displayName, sublabel: e.engineId, enabled: e.enabled, keyCount: e.keyCount }))

  const decisionItems: Item[] = decisions
    .filter(d => d.platform === platform)
    .map(d => ({ kind: 'decision', id: d.id, label: d.displayName, sublabel: d.modelId, enabled: d.enabled, keyCount: d.keyCount }))

  const items = [...chatItems, ...searchItems, ...decisionItems]
  const [tests, setTests] = useState<Record<string, TestState>>({})

  function itemKey(item: Item) { return `${item.kind}:${item.id}` }

  async function runTest(item: Item) {
    const key = itemKey(item)
    const current = tests[key]
    const now = nowMs()
    if (current?.loading) return
    if (current?.lastTestedAt && now - current.lastTestedAt < MODEL_TEST_MIN_INTERVAL_MS) {
      const wait = Math.ceil((MODEL_TEST_MIN_INTERVAL_MS - (now - current.lastTestedAt)) / 1000)
      toast.error(t('keys.testThrottled', { seconds: wait }))
      return
    }
    setTests(prev => ({ ...prev, [key]: { loading: true, lastTestedAt: now } }))
    const started = performance.now()
    try {
      let success = false
      let latencyMs = 0
      let error: string | undefined
      if (item.kind === 'chat') {
        const res = await apiFetch<{ success: boolean; latencyMs: number; error?: string }>(`/api/models/${item.id}/test`, { method: 'POST' })
        success = res.success
        latencyMs = res.latencyMs
        error = res.error
      } else if (item.kind === 'search') {
        try {
          await apiFetch(`/api/search/engines/${item.id}/test`, { method: 'POST', body: JSON.stringify({ query: 'OpenAI' }) })
          success = true
          latencyMs = Math.round(performance.now() - started)
        } catch (err: unknown) {
          success = false
          error = err instanceof Error ? err.message : t('keys.testFailed')
        }
      } else {
        const res = await apiFetch<{ success: boolean; latencyMs: number; error?: string }>(`/api/decisions/models/${item.id}/test`, { method: 'POST' })
        success = res.success
        latencyMs = res.latencyMs
        error = res.error
      }
      setTests(prev => ({ ...prev, [key]: { loading: false, lastTestedAt: nowMs(), result: { success, latencyMs, error } } }))
      if (success) toast.success(t('keys.testPassed', { latency: latencyMs }))
      else toast.error(error || t('keys.testFailed'))
    } catch (err: unknown) {
      const error = (err instanceof Error ? err.message : null) || t('keys.testFailed')
      setTests(prev => ({ ...prev, [key]: { loading: false, lastTestedAt: nowMs(), result: { success: false, latencyMs: 0, error } } }))
      toast.error(error)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-2xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <FlaskConical className="size-5 text-primary" />
            <DialogTitle className="truncate">{t('keys.testModels')} · {label}</DialogTitle>
          </div>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : items.length === 0 ? (
          <EmptyState title={t('keys.noModelsForProvider')} />
        ) : (
          <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-2xl border" data-testid="test-models-list">
            {items.map(item => {
              const key = itemKey(item)
              const state = tests[key]
              return (
                <li key={key} className={`flex items-center gap-3 px-3 py-2 text-sm ${item.enabled ? '' : 'opacity-60'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{item.label}</div>
                    <code className="block truncate text-[11px] text-muted-foreground" title={item.sublabel}>{item.sublabel}</code>
                  </div>
                  {state?.result && !state.loading && (
                    state.result.success ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 tabular-nums" role="status">
                        <CheckCircle2 className="size-3.5" />
                        {t('keys.testPassedShort')} · {state.result.latencyMs}ms
                      </span>
                    ) : (
                      <span className="inline-flex max-w-[260px] items-center gap-1 text-xs text-destructive" role="status" title={state.result.error}>
                        <CircleAlert className="size-3.5 flex-shrink-0" />
                        <span className="truncate">{t('keys.testFailedShort')}{state.result.error ? ` · ${state.result.error}` : ''}</span>
                      </span>
                    )
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={state?.loading || item.keyCount === 0}
                    onClick={() => void runTest(item)}
                    aria-label={`${t('keys.testModel')} ${item.label}`}
                  >
                    {state?.loading ? <Loader2 className="size-3 animate-spin" /> : t('keys.testModel')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </DialogPopup>
    </Dialog>
  )
}
