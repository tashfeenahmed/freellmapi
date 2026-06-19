import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Layers } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { buildModelOptions } from '@/lib/model-groups'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { useI18n } from '@/i18n'

type Mode = 'auto' | 'explicit'
type Strategy = 'synthesize' | 'best_of'

interface SavedFusionConfig {
  mode: Mode
  models: string[]
  judge: string | null
  k: number
  strategy: Strategy
  expose_panel: boolean
}

interface FusionConfigResponse {
  config: SavedFusionConfig
  maxK: number
}

interface FallbackEntry {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  keyCount: number
}

const JUDGE_AUTO = '__auto__'

export default function FusionPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<FusionConfigResponse>({
    queryKey: ['fusion-config'],
    queryFn: () => apiFetch('/api/settings/fusion'),
  })
  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: unify } = useQuery<{ enabled: boolean }>({
    queryKey: ['unify'],
    queryFn: () => apiFetch('/api/settings/unify'),
  })
  const unifyOn = unify?.enabled ?? true

  // Models that can actually serve a request right now (enabled + a key).
  const availableModels = useMemo(
    () => fallbackEntries.filter(e => e.keyCount > 0 && e.enabled),
    [fallbackEntries],
  )
  // When unify is on, the panel/judge pickers offer ONE option per logical
  // model (value = canonical id); the fusion service resolves it to the group's
  // best member. When off, one option per provider row, as before.
  const modelOptions = useMemo(() => buildModelOptions(availableModels, unifyOn), [availableModels, unifyOn])

  const [mode, setMode] = useState<Mode>('auto')
  const [models, setModels] = useState<string[]>([])
  const [judge, setJudge] = useState<string>(JUDGE_AUTO)
  const [k, setK] = useState<number>(4)
  const [strategy, setStrategy] = useState<Strategy>('synthesize')
  const [exposePanel, setExposePanel] = useState<boolean>(false)

  // Hydrate local state from the server once it loads.
  useEffect(() => {
    if (!data) return
    setMode(data.config.mode)
    setModels(data.config.models)
    setJudge(data.config.judge ?? JUDGE_AUTO)
    setK(data.config.k)
    setStrategy(data.config.strategy)
    setExposePanel(data.config.expose_panel)
  }, [data])

  const maxK = data?.maxK ?? 8

  const saveMutation = useMutation({
    mutationFn: (body: SavedFusionConfig) =>
      apiFetch<FusionConfigResponse>('/api/settings/fusion', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (res) => queryClient.setQueryData(['fusion-config'], res),
  })

  const draft: SavedFusionConfig = {
    mode,
    models,
    judge: judge === JUDGE_AUTO ? null : judge,
    k: Math.min(Math.max(k || 1, 1), maxK),
    strategy,
    expose_panel: exposePanel,
  }

  const hasChanges = !!data && JSON.stringify({
    ...data.config,
    judge: data.config.judge ?? null,
  }) !== JSON.stringify(draft)

  const toggleModel = (modelId: string) => {
    setModels(prev => prev.includes(modelId)
      ? prev.filter(m => m !== modelId)
      : (prev.length >= maxK ? prev : [...prev, modelId]))
  }

  return (
    <div>
      <PageHeader
        title={t('fusion.title')}
        description={t('fusion.description')}
        divider={false}
        actions={<ModelsTabs />}
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="space-y-8">
          {/* Panel mode */}
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">{t('fusion.panelSource')}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t('fusion.panelSourceHelp')}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(['auto', 'explicit'] as Mode[]).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-xl border p-3 text-left transition-colors ${
                    mode === m ? 'border-foreground bg-muted/50' : 'hover:bg-muted/30'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{t(`fusion.mode.${m}`)}</span>
                    {mode === m && <Check className="size-4" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{t(`fusion.mode.${m}Help`)}</p>
                </button>
              ))}
            </div>
          </section>

          {/* Explicit panel picker */}
          {mode === 'explicit' && (
            <section className="space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium">{t('fusion.panelModels')}</h2>
                <span className="text-xs text-muted-foreground">{t('fusion.selectedCount', { count: models.length, max: maxK })}</span>
              </div>
              {modelOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('fusion.noModels')}</p>
              ) : (
                <div className="max-h-80 overflow-y-auto rounded-xl border divide-y">
                  {modelOptions.map(o => {
                    const selected = models.includes(o.value)
                    const atCap = !selected && models.length >= maxK
                    return (
                      <button
                        key={o.value}
                        type="button"
                        disabled={atCap}
                        onClick={() => toggleModel(o.value)}
                        className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                          selected ? 'bg-muted/50' : atCap ? 'opacity-40' : 'hover:bg-muted/30'
                        }`}
                      >
                        <span className={`flex size-4 items-center justify-center rounded border ${selected ? 'bg-foreground text-background' : ''}`}>
                          {selected && <Check className="size-3" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-sm font-medium">{o.label}</span>
                          <span className="ml-2 font-mono text-[11px] text-muted-foreground">{o.value}</span>
                        </span>
                        <Badge variant="secondary" className="text-[10px]">
                          {o.providerCount > 1 ? t('models.providerCount', { count: o.providerCount }) : o.platform}
                        </Badge>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          {/* Auto panel size */}
          {mode === 'auto' && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">{t('fusion.panelSize')}</h2>
              <p className="text-xs text-muted-foreground">{t('fusion.panelSizeHelp', { max: maxK })}</p>
              <Input
                type="number" min={1} max={maxK} value={k}
                onChange={e => setK(Number(e.target.value))}
                className="w-28"
              />
            </section>
          )}

          {/* Judge */}
          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t('fusion.judge')}</h2>
            <p className="text-xs text-muted-foreground">{t('fusion.judgeHelp')}</p>
            <Select value={judge} onValueChange={v => setJudge(v ?? JUDGE_AUTO)}>
              <SelectTrigger className="w-full max-w-md">
                <SelectValue>
                  {(v: string) => (!v || v === JUDGE_AUTO)
                    ? t('fusion.judgeAuto')
                    : (modelOptions.find(o => o.value === v)?.label ?? v)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={JUDGE_AUTO}>{t('fusion.judgeAuto')}</SelectItem>
                {modelOptions.map(o => (
                  <SelectItem key={o.value} value={o.value}>
                    <span className="flex items-center gap-2">
                      <span>{o.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {o.providerCount > 1 ? t('models.providerCount', { count: o.providerCount }) : o.platform}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          {/* Strategy */}
          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t('fusion.strategy')}</h2>
            <Select value={strategy} onValueChange={v => { if (v) setStrategy(v as Strategy) }}>
              <SelectTrigger className="w-full max-w-md">
                <SelectValue>
                  {(v: string) => v === 'best_of' ? t('fusion.strategyBestOfShort') : t('fusion.strategySynthesizeShort')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="synthesize">{t('fusion.strategySynthesize')}</SelectItem>
                <SelectItem value="best_of">{t('fusion.strategyBestOf')}</SelectItem>
              </SelectContent>
            </Select>
          </section>

          {/* Expose panel */}
          <section className="flex items-center justify-between rounded-xl border p-3">
            <div className="min-w-0 pr-4">
              <h2 className="text-sm font-medium">{t('fusion.exposePanel')}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t('fusion.exposePanelHelp')}</p>
            </div>
            <Switch checked={exposePanel} onCheckedChange={setExposePanel} />
          </section>

          {/* Usage hint */}
          <section className="rounded-xl border bg-muted/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Layers className="size-4" />
              <h2 className="text-sm font-medium">{t('fusion.howToUse')}</h2>
            </div>
            <p className="text-xs text-muted-foreground mb-2">{t('fusion.howToUseHelp')}</p>
            <pre className="overflow-x-auto rounded-lg bg-background p-3 text-[11px] leading-relaxed font-mono border">{`POST /v1/chat/completions
{
  "model": "fusion",
  "messages": [ ... ]
}`}</pre>
          </section>
        </div>
      )}

      <FloatingBar show={hasChanges}>
        <span className="text-xs text-muted-foreground">{t('fusion.unsavedChanges')}</span>
        <Button size="sm" onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? t('common.loading') : t('fusion.save')}
        </Button>
      </FloatingBar>
    </div>
  )
}
