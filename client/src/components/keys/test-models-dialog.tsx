import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, CircleAlert, FlaskConical, Loader2, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import type { Model, ModelTestResult } from '@freellmapi/shared/types'
import { MODEL_TEST_MIN_INTERVAL_MS, nowMs, selectTestableModels } from '@/lib/test-models'

// Fire one real "ping" at a model through the normal pinned routing path
// (POST /api/models/:id/test honours key scope, cooldowns, concurrency and
// budgets) and show pass/fail with latency. Lived on the Providers page
// before that page was folded into Keys; the dialog lists the models of ONE
// provider — or, for a custom endpoint, of one key — so the Keys page can
// stay key-centric and still answer "does this provider actually work".

interface TestState {
  loading: boolean
  lastTestedAt?: number
  result?: { success: boolean; latencyMs: number; error?: string }
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
  const { data: models = [], isLoading } = useQuery<Model[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })
  const rows = selectTestableModels(models, platform, keyId)
  const [tests, setTests] = useState<Record<number, TestState>>({})

  async function runTest(model: Model) {
    const current = tests[model.id]
    const now = nowMs()
    if (current?.loading) return
    if (current?.lastTestedAt && now - current.lastTestedAt < MODEL_TEST_MIN_INTERVAL_MS) {
      const wait = Math.ceil((MODEL_TEST_MIN_INTERVAL_MS - (now - current.lastTestedAt)) / 1000)
      toast.error(t('keys.testThrottled', { seconds: wait }))
      return
    }
    setTests(prev => ({ ...prev, [model.id]: { loading: true, lastTestedAt: now } }))
    try {
      const res = await apiFetch<ModelTestResult>(`/api/models/${model.id}/test`, { method: 'POST' })
      setTests(prev => ({
        ...prev,
        [model.id]: { loading: false, lastTestedAt: nowMs(), result: { success: res.success, latencyMs: res.latencyMs, error: res.error } },
      }))
      if (res.success) toast.success(t('keys.testPassed', { latency: res.latencyMs }))
      else toast.error(res.error || t('keys.testFailed'))
    } catch (err: unknown) {
      const error = (err instanceof Error ? err.message : null) || t('keys.testFailed')
      setTests(prev => ({
        ...prev,
        [model.id]: { loading: false, lastTestedAt: nowMs(), result: { success: false, latencyMs: 0, error } },
      }))
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
        ) : rows.length === 0 ? (
          <EmptyState title={t('keys.noModelsForProvider')} />
        ) : (
          <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-2xl border" data-testid="test-models-list">
            {rows.map(model => {
              const state = tests[model.id]
              return (
                <li key={model.id} className={`flex items-center gap-3 px-3 py-2 text-sm ${model.enabled ? '' : 'opacity-60'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{model.displayName}</div>
                    <code className="block truncate text-[11px] text-muted-foreground" title={model.modelId}>{model.modelId}</code>
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
                    disabled={state?.loading}
                    onClick={() => void runTest(model)}
                    aria-label={`${t('keys.testModel')} ${model.displayName}`}
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
