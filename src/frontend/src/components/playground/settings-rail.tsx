import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ModelCombobox, type ModelComboOption } from '@/components/model-combobox'
import {
  SAMPLING_FIELDS,
  SAMPLING_RANGES,
  formatSamplingValue,
  samplingActiveCount,
  setSamplingEnabled,
  setSamplingValue,
  type SamplingField,
  type SamplingSettings,
} from '@/lib/playground-sampling'
import { useI18n } from '@/i18n'

// The Playground's right-hand settings rail: everything that shapes the NEXT
// request but is not the request itself — which model answers, the system
// prompt it answers under, and the sampling knobs.
//
// It mirrors the conversation sidebar on the other edge: same collapse-to-a-
// strip move, same width animation, same remembered open/closed choice (kept by
// the page). Collapsed it still says whether anything is set, so a temperature
// you dialled in last week cannot quietly steer today's answers from behind a
// closed rail.
//
// Deliberately dumb, like the sidebar: it owns no state, every change goes up
// to PlaygroundPage, which persists it.

const FIELD_LABEL_KEYS: Record<SamplingField, string> = {
  temperature: 'playground.temperature',
  topP: 'playground.topP',
  maxTokens: 'playground.maxTokens',
}

// The open panel and the collapsed strip are stacked inside one container whose
// WIDTH animates; each keeps its own fixed width so the contents never reflow
// mid-move, and the idle one fades to `invisible` (out of the tab order too).
const LAYER =
  'absolute inset-y-0 end-0 flex flex-col transition-[opacity,visibility] duration-200 ease-out motion-reduce:transition-none'

export interface SettingsRailProps {
  open: boolean
  onToggle: () => void
  /** Model picker, moved here from the page header. */
  modelValue: string
  modelOptions: ModelComboOption[]
  onSelectModel: (value: string) => void
  /** Shown under the picker when no platform has an enabled key yet. */
  noModels: boolean
  systemPrompt: string
  onSystemPromptChange: (value: string) => void
  sampling: SamplingSettings
  onSamplingChange: (next: SamplingSettings) => void
}

function SamplingControlRow({
  field,
  settings,
  onChange,
}: {
  field: SamplingField
  settings: SamplingSettings
  onChange: (next: SamplingSettings) => void
}) {
  const { t } = useI18n()
  const range = SAMPLING_RANGES[field]
  const control = settings[field]
  const label = t(FIELD_LABEL_KEYS[field])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label
          htmlFor={`playground-sampling-${field}`}
          className={`flex-1 truncate text-xs font-medium transition-colors ${
            control.enabled ? '' : 'text-muted-foreground'
          }`}
        >
          {label}
        </label>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {control.enabled
            ? formatSamplingValue(field, control.value)
            : t('playground.samplingDefault')}
        </span>
        <Switch
          size="sm"
          aria-label={label}
          checked={control.enabled}
          onCheckedChange={enabled => onChange(setSamplingEnabled(settings, field, enabled))}
        />
      </div>
      {/* max_tokens is an unbounded integer in practice, so it gets a box; the
          two [0,1]-ish knobs get sliders you can sweep. A switched-off control
          stays on screen, disabled, so the rail does not jump as you toggle. */}
      {field === 'maxTokens' ? (
        <input
          id={`playground-sampling-${field}`}
          type="number"
          inputMode="numeric"
          min={range.min}
          max={range.max}
          step={range.step}
          disabled={!control.enabled}
          value={control.value}
          onChange={e => onChange(setSamplingValue(settings, field, Number(e.target.value)))}
          aria-label={label}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        />
      ) : (
        <input
          id={`playground-sampling-${field}`}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          disabled={!control.enabled}
          value={control.value}
          onChange={e => onChange(setSamplingValue(settings, field, Number(e.target.value)))}
          aria-label={label}
          className="w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
      )}
    </div>
  )
}

export function SettingsRail({
  open,
  onToggle,
  modelValue,
  modelOptions,
  onSelectModel,
  noModels,
  systemPrompt,
  onSystemPromptChange,
  sampling,
  onSamplingChange,
}: SettingsRailProps) {
  const { t } = useI18n()
  // Anything the collapsed strip should own up to: a system prompt riding on
  // every request, or a knob overriding the provider's default.
  const tweaked = samplingActiveCount(sampling) > 0 || systemPrompt.trim().length > 0

  return (
    <div
      className={`relative shrink-0 overflow-hidden border-s bg-card transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'w-72' : 'w-11'
      }`}
    >
      <div
        className={`${LAYER} w-11 items-center gap-1 py-3 ${
          open ? 'invisible opacity-0' : 'visible opacity-100'
        }`}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          aria-label={t('playground.showSettings')}
          title={t('playground.showSettings')}
        >
          <PanelRightOpen className="size-4" />
        </Button>
        {tweaked && <span className="size-1.5 rounded-full bg-primary/70" />}
      </div>

      <div
        className={`${LAYER} w-72 ${open ? 'visible opacity-100' : 'invisible opacity-0'}`}
      >
        <div className="flex shrink-0 items-center gap-1 border-b px-2.5 py-2">
          <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
            {t('settings.title')}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggle}
            aria-label={t('playground.hideSettings')}
            title={t('playground.hideSettings')}
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
          <div className="space-y-1.5">
            <span className="block text-xs font-medium">{t('common.model')}</span>
            <ModelCombobox
              value={modelValue}
              options={modelOptions}
              onSelect={onSelectModel}
              ariaLabel={t('playground.selectModel')}
              placeholder={t('playground.searchModels')}
              emptyText={t('playground.noModelsFound')}
              align="end"
              triggerClassName="flex h-8 w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              footer={
                noModels ? (
                  // Models only appear once a platform has an enabled key. Without
                  // one, the list is just Auto/Fusion and looks broken — say why. (#269)
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('playground.noModels')}</div>
                ) : undefined
              }
            />
          </div>

          {/* The system prompt textarea deliberately lives BELOW the composer in
              DOM order (the rail is the last column): `textarea` first-match
              selectors still land on the message box. */}
          <div className="space-y-1.5">
            <label htmlFor="playground-system-prompt" className="flex items-center gap-1.5 text-xs font-medium">
              {t('playground.systemPromptLabel')}
              {systemPrompt.trim() && <span className="size-1.5 rounded-full bg-primary/70" />}
            </label>
            <textarea
              id="playground-system-prompt"
              value={systemPrompt}
              onChange={e => onSystemPromptChange(e.target.value)}
              placeholder={t('playground.systemPromptPlaceholder')}
              rows={4}
              className="max-h-64 min-h-[88px] w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
            />
          </div>

          <div className="space-y-3">
            <div className="space-y-0.5">
              <span className="block text-xs font-medium">{t('playground.samplingHeading')}</span>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t('playground.samplingHelp')}
              </p>
            </div>
            {SAMPLING_FIELDS.map(field => (
              <SamplingControlRow
                key={field}
                field={field}
                settings={sampling}
                onChange={onSamplingChange}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
