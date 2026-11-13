import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Scale } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmptyState } from '@/components/empty-state'
import { CardSkeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { CodeBlock } from '@/components/code-block'
import { useI18n } from '@/i18n'
import {
  decisionExampleCurl,
  parseOptions,
  topProbabilities,
  type DecisionModel,
  type DecisionResult,
} from '@/lib/decision'

const AUTO = 'auto'

// One model from the catalog's `decisionModels` section. Decision models are
// not part of chat routing unless the Decision routing strategy is on (#1354);
// the toggle affects POST /v1/decisions and that strategy alike.
function DecisionModelCard({
  model: m,
  onToggle,
  pending,
}: {
  model: DecisionModel
  onToggle: (enabled: boolean) => void
  pending: boolean
}) {
  const { t } = useI18n()
  return (
    <section className={`rounded-3xl border bg-card p-5 ${m.enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{m.displayName}</span>
            {m.keyCount === 0 && (
              <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
                {t('models.noKey')}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{m.modelId}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {[m.platform, m.quotaLabel].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('decision.thisMonth', { count: m.decisionsThisMonth })}
        </span>
        <Switch checked={m.enabled} onCheckedChange={onToggle} disabled={pending} aria-label={m.displayName} />
      </div>
    </section>
  )
}

// "Try it": one choice question over the typed text, run through the same
// chain as POST /v1/decisions.
function TryDecision({ models }: { models: DecisionModel[] }) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState('')
  const [model, setModel] = useState(AUTO)
  const [latency, setLatency] = useState<number | null>(null)

  const run = useMutation({
    mutationFn: async (): Promise<DecisionResult> => {
      const started = performance.now()
      const result = await apiFetch<DecisionResult>('/api/decisions/try', {
        method: 'POST',
        body: JSON.stringify({
          state: text.trim() || t('decision.tryTextPlaceholder'),
          question: question.trim() || t('decision.tryQuestionPlaceholder'),
          options: parseOptions(options || t('decision.tryOptionsPlaceholder')),
          ...(model !== AUTO ? { model } : {}),
        }),
      })
      setLatency(Math.round(performance.now() - started))
      return result
    },
  })

  const optionList = parseOptions(options || t('decision.tryOptionsPlaceholder'))
  const answer = run.data?.answers?.answer as { choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined
  const enabled = models.filter(m => m.enabled)

  return (
    <section className="rounded-3xl border bg-card p-5 space-y-3">
      <h2 className="text-sm font-medium">{t('decision.tryTitle')}</h2>
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor="decision-text">{t('decision.tryText')}</Label>
        <Textarea
          id="decision-text"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={t('decision.tryTextPlaceholder')}
          rows={3}
        />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="space-y-1.5 flex-1">
          <Label className="text-xs" htmlFor="decision-question">{t('decision.tryQuestion')}</Label>
          <Input
            id="decision-question"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder={t('decision.tryQuestionPlaceholder')}
          />
        </div>
        <div className="space-y-1.5 flex-1">
          <Label className="text-xs" htmlFor="decision-options">{t('decision.tryOptions')}</Label>
          <Input
            id="decision-options"
            value={options}
            onChange={e => setOptions(e.target.value)}
            placeholder={t('decision.tryOptionsPlaceholder')}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('decision.tryModel')}</Label>
          <Select
            value={model}
            onValueChange={value => setModel(String(value))}
            items={[{ value: AUTO, label: t('decision.tryAuto') }, ...enabled.map(m => ({ value: m.modelId, label: m.displayName }))]}
          >
            <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO} label={t('decision.tryAuto')}>{t('decision.tryAuto')}</SelectItem>
              {enabled.map(m => (
                <SelectItem key={m.id} value={m.modelId} label={m.displayName}>{m.displayName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => run.mutate()} disabled={run.isPending || optionList.length < 2}>
          {run.isPending ? t('decision.tryRunning') : t('decision.tryRun')}
        </Button>
        {optionList.length < 2 && <span className="text-xs text-muted-foreground">{t('decision.tryNeedOptions')}</span>}
      </div>

      {run.error && <p className="text-xs text-destructive">{(run.error as Error).message}</p>}
      {answer?.choice && (
        <div className="space-y-2 rounded-2xl bg-muted/50 p-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium">{t('decision.tryAnswer', { choice: answer.choice })}</span>
            {typeof answer.confidence === 'number' && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('decision.tryConfidence', { value: Math.round(answer.confidence * 100) })}
              </span>
            )}
            <span className="flex-1" />
            <span className="font-mono text-[11px] text-muted-foreground">
              {t('decision.tryServedBy', { model: run.data!.model, latency: latency ?? 0 })}
            </span>
          </div>
          {topProbabilities(answer.probabilities).map(([option, p]) => (
            <div key={option} className="flex items-center gap-2 text-xs">
              <span className="w-28 truncate">{option}</span>
              <div className="h-1.5 flex-1 rounded-full bg-muted">
                <div className="h-1.5 rounded-full bg-foreground" style={{ width: `${Math.round(p * 100)}%` }} />
              </div>
              <span className="w-10 text-right tabular-nums text-muted-foreground">{Math.round(p * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// Models → Decision: the catalog's decision models, a "Try it" box and an
// example request for POST /v1/decisions.
export function DecisionModelsView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: models = [], isLoading } = useQuery<DecisionModel[]>({
    queryKey: ['decision-models'],
    queryFn: () => apiFetch('/api/decisions/models'),
    refetchInterval: 30_000,
  })

  const update = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/decisions/models/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['decision-models'] }),
  })

  const ordered = models.slice().sort((a, b) => a.priority - b.priority || a.id - b.id)

  return (
    <div>
      <PageHeader title={t('models.title')} description={t('decision.pageDesc')} divider={false} actions={<ModelsTabs />} />

      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t('decision.endpointHint')}{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">POST /v1/decisions</code>{' '}
          {t('decision.notRoutingHint')}
        </p>

        {isLoading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : ordered.length === 0 ? (
          <EmptyState icon={Scale} title={t('decision.empty')} />
        ) : (
          <>
            {ordered.map(m => (
              <DecisionModelCard
                key={m.id}
                model={m}
                onToggle={enabled => update.mutate({ id: m.id, enabled })}
                pending={update.isPending}
              />
            ))}
            <TryDecision models={ordered} />
            <section className="rounded-3xl border bg-card p-5 space-y-2">
              <h2 className="text-sm font-medium">{t('decision.exampleTitle')}</h2>
              <div className="overflow-x-auto rounded-2xl bg-muted/50 p-4">
                <CodeBlock code={decisionExampleCurl(window.location.origin)} language="bash" />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
