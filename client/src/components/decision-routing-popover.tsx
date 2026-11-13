import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { KeyRound, SlidersHorizontal } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { PLATFORMS } from '@/components/keys/shared'
import type { DecisionModel } from '@/lib/decision'
import type { DecisionRoutingStatus } from '@/lib/routing'

const AUTO = 'auto'
// The presets a decision model picks between, in the order the pills show them.
// `tKey` is the label suffix under `strategies.*`.
const PICKS: { key: keyof DecisionRoutingStatus['counts']; tKey: string }[] = [
  { key: 'smartest', tKey: 'smartest' },
  { key: 'fastest', tKey: 'fastest' },
  { key: 'balanced', tKey: 'balanced' },
  { key: 'reliable', tKey: 'reliable' },
]

// Settings for the 'decision' strategy (#1354): which decision model picks the
// preset for each request, and how sure it must be before its pick is used.
// Below that, or when it is slow or unavailable, the request routes as
// Balanced. Nothing is saved until Apply is pressed.
export function DecisionRoutingPopover({ status, onSave, saving }: {
  status: DecisionRoutingStatus
  onSave: (settings: { decisionModel: string; decisionMinProbability: number }) => void
  saving: boolean
}) {
  const { t } = useI18n()
  const [model, setModel] = useState(status.model)
  const [minPercent, setMinPercent] = useState(Math.round(status.minProbability * 100))
  const [dirty, setDirty] = useState(false)

  const { data: models = [] } = useQuery<DecisionModel[]>({
    queryKey: ['decision-models'],
    queryFn: () => apiFetch('/api/decisions/models'),
  })
  const choices = models.filter(m => m.enabled).sort((a, b) => a.priority - b.priority || a.id - b.id)
  const total = PICKS.reduce((n, p) => n + (status.counts[p.key] ?? 0), 0)
  const fallbacks = Object.values(status.fallbacks).reduce((n, v) => n + (v ?? 0), 0)

  function apply() {
    onSave({ decisionModel: model, decisionMinProbability: minPercent / 100 })
    setDirty(false)
  }

  return (
    <Popover onOpenChange={open => {
      if (open) { setModel(status.model); setMinPercent(Math.round(status.minProbability * 100)); setDirty(false) }
    }}>
      <PopoverTrigger className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
        <SlidersHorizontal className="size-3.5" />
        {t('strategies.adjust')}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t('strategies.decisionSettings')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('strategies.decisionSettingsHelp')}</p>
          </div>

          {!status.ready && (
            <div className="space-y-2">
              <p className="text-xs text-amber-600 dark:text-amber-500">{t('strategies.decisionNotReady')}</p>
              <DecisionSetupActions status={status} />
            </div>
          )}

          <label className="block text-xs">
            <span className="mb-1 block">{t('strategies.decisionModel')}</span>
            <select
              value={model}
              onChange={e => { setModel(e.target.value); setDirty(true) }}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
            >
              <option value={AUTO}>{t('strategies.decisionModelAuto')}</option>
              {choices.map(m => (
                <option key={m.id} value={m.modelId}>{m.displayName}</option>
              ))}
              {model !== AUTO && !choices.some(m => m.modelId === model) && <option value={model}>{model}</option>}
            </select>
          </label>

          <div>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span>{t('strategies.decisionMinConfidence')}</span>
              <span className="tabular-nums text-muted-foreground">{minPercent}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={minPercent}
              onChange={e => { setMinPercent(Number(e.target.value)); setDirty(true) }}
              className="w-full cursor-pointer"
              aria-label={t('strategies.decisionMinConfidence')}
            />
            <p className="mt-0.5 text-xs text-muted-foreground">{t('strategies.decisionMinConfidenceHelp')}</p>
          </div>

          {total > 0 && (
            <div className="text-xs">
              <p className="mb-1 text-muted-foreground">{t('strategies.decisionPicks', { total })}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {PICKS.map(p => (
                  <span key={p.key}>{t(`strategies.${p.tKey}`)} <span className="tabular-nums text-muted-foreground">{status.counts[p.key] ?? 0}</span></span>
                ))}
              </div>
              {fallbacks > 0 && (
                <p className="mt-1 text-muted-foreground">{t('strategies.decisionFallbacks', { count: fallbacks })}</p>
              )}
            </div>
          )}

          <Button size="sm" className="w-full" disabled={!dirty || saving} onClick={apply}>
            {saving ? t('common.applying') : dirty ? t('common.apply') : t('common.applied')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// What gets Decision routing working: one "Add <provider> key" button per
// provider that has an enabled decision model (opens Keys with that provider
// preselected), or a pointer to Models → Decision when none is turned on.
function DecisionSetupActions({ status }: { status: DecisionRoutingStatus }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const label = (platform: string) => PLATFORMS.find(p => p.value === platform)?.label ?? platform
  return (
    <div className="space-y-2">
      {status.hasModels ? (
        <div className="flex flex-col gap-1.5">
          {status.keyPlatforms.map(platform => (
            <Button key={platform} size="sm" className="w-full justify-start" onClick={() => navigate(`/keys?add=${encodeURIComponent(platform)}`)}>
              <KeyRound className="size-3.5" />
              {t('strategies.decisionAddKey', { provider: label(platform) })}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('strategies.decisionNoModels')}</p>
      )}
      <Button size="sm" variant="outline" className="w-full" onClick={() => navigate('/models/decision')}>
        {t('strategies.decisionOpenModels')}
      </Button>
    </div>
  )
}

// The Decision pill while nothing can decide yet (#1354): instead of switching
// to a strategy that would silently route everything as Balanced, a click
// opens this guide to the one key that makes it work. `children` is the pill.
export function DecisionSetupGuide({ status, className, children }: {
  status: DecisionRoutingStatus
  className: string
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <Popover>
      <PopoverTrigger className={className}>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">{t('strategies.decisionSetupTitle')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('strategies.decisionSetupHelp')}</p>
          </div>
          <DecisionSetupActions status={status} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
