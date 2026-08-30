import { useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import type { RoutingWeights } from '@/lib/routing'

// Slider axes share the colors used by the score table columns.
// `tKey` is the i18n suffix under `strategies.weight*`.
const WEIGHT_AXES: { key: keyof RoutingWeights; tKey: string; color: string }[] = [
  { key: 'reliability', tKey: 'weightReliability', color: '#22c55e' },
  { key: 'speed', tKey: 'weightSpeed', color: '#3b82f6' },
  { key: 'intelligence', tKey: 'weightIntelligence', color: '#a855f7' },
]

// Slider popover for the 'custom' strategy. Sliders are independent (0-100)
// and the server renormalizes any vector, so we just show each axis's
// effective share live. Nothing is saved until Apply is pressed.
export function CustomWeightsPopover({ saved, onSave, saving }: {
  saved: RoutingWeights
  onSave: (w: RoutingWeights) => void
  saving: boolean
}) {
  const { t } = useI18n()
  const [values, setValues] = useState<RoutingWeights>(() => fromSaved(saved))
  const [dirty, setDirty] = useState(false)

  // Defensive: an older/partial server response (or a future field rename) could
  // leave `saved` undefined; never let that white-screen the whole page. Fall
  // back to an even split.
  function fromSaved(w?: RoutingWeights): RoutingWeights {
    const safe = w ?? { reliability: 1 / 3, speed: 1 / 3, intelligence: 1 / 3 }
    return {
      reliability: Math.round(safe.reliability * 100),
      speed: Math.round(safe.speed * 100),
      intelligence: Math.round(safe.intelligence * 100),
    }
  }

  function update(key: keyof RoutingWeights, v: number) {
    setValues({ ...values, [key]: v })
    setDirty(true)
  }

  function apply() {
    if (sum <= 0) return
    onSave({
      reliability: values.reliability / 100,
      speed: values.speed / 100,
      intelligence: values.intelligence / 100,
    })
    setDirty(false)
  }

  const sum = values.reliability + values.speed + values.intelligence

  return (
    <Popover onOpenChange={open => { if (open) { setValues(fromSaved(saved)); setDirty(false) } }}>
      <PopoverTrigger className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
        <SlidersHorizontal className="size-3.5" />
        {t('strategies.adjust')}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t('strategies.customWeights')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('strategies.customWeightsHelp')}
            </p>
          </div>
          {WEIGHT_AXES.map(axis => {
            const share = sum > 0 ? Math.round((values[axis.key] / sum) * 100) : 0
            const axisLabel = t(`strategies.${axis.tKey}`)
            return (
              <div key={axis.key}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: axis.color }} />
                    {axisLabel}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{share}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={values[axis.key]}
                  onChange={e => update(axis.key, Number(e.target.value))}
                  className="w-full cursor-pointer"
                  style={{ accentColor: axis.color }}
                  aria-label={`${axisLabel} weight`}
                />
              </div>
            )
          })}
          {sum <= 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t('strategies.weightRequired')}
            </p>
          )}
          <Button
            size="sm"
            className="w-full"
            disabled={!dirty || sum <= 0 || saving}
            onClick={apply}
          >
            {saving ? t('common.applying') : dirty ? t('common.apply') : t('common.applied')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
