import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n'
import { Tooltip } from '@/components/tooltip'
import { PEAK_EXEMPT_STRATEGIES, type RoutingData, type RoutingStrategy } from '@/lib/routing'

const HOURS = Array.from({ length: 24 }, (_, i) => i)

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** Whether the runtime recognises this IANA name. Mirrors the server check so a
 *  typo is caught before it becomes a 400 the user has to decode. */
function isKnownTimezone(name: string): boolean {
  if (!name.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

export interface PeakHoursPatch {
  peakHoursAdjust?: boolean
  peakStartHour?: number
  peakEndHour?: number
  peakTimezone?: string
}

/**
 * Opt-in time-of-day reweighting (#760), rendered at the same footnote tier as
 * the Explore toggle rather than in a card of its own. Off — the default — it
 * is one checkbox and nothing else; the window inputs appear only once someone
 * turns it on.
 */
export function PeakHoursControls({ routing, strategy, saving, onSave }: {
  routing: RoutingData
  strategy: RoutingStrategy
  saving: boolean
  onSave: (patch: PeakHoursPatch) => void
}) {
  const { t } = useI18n()
  const [tz, setTz] = useState(routing.peakTimezone)
  const [tzError, setTzError] = useState(false)

  // Re-sync when the server's value changes under us (poll, or another tab).
  useEffect(() => { setTz(routing.peakTimezone); setTzError(false) }, [routing.peakTimezone])

  const enabled = routing.peakHoursAdjust
  const exempt = PEAK_EXEMPT_STRATEGIES.includes(strategy)

  function commitTimezone(value: string) {
    const next = value.trim()
    if (next === routing.peakTimezone) { setTzError(false); return }
    if (!isKnownTimezone(next)) { setTzError(true); return }
    setTzError(false)
    onSave({ peakTimezone: next })
  }

  return (
    <div className="mt-2">
      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={e => onSave({ peakHoursAdjust: e.target.checked })}
          className="size-3.5 accent-foreground"
        />
        <span>{t('strategies.peakAdjust')}</span>
        <Tooltip text={t('strategies.peakAdjustHint')}>
          <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
        </Tooltip>
      </label>

      {enabled && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 pl-5.5 text-xs text-muted-foreground">
          <span>{t('strategies.peakFrom')}</span>
          <select
            value={routing.peakStartHour}
            disabled={saving}
            aria-label={t('strategies.peakFrom')}
            onChange={e => onSave({ peakStartHour: Number(e.target.value) })}
            className="rounded-lg border bg-card px-1.5 py-0.5 tabular-nums outline-none focus:border-foreground/30"
          >
            {HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <span>{t('strategies.peakTo')}</span>
          <select
            value={routing.peakEndHour}
            disabled={saving}
            aria-label={t('strategies.peakTo')}
            onChange={e => onSave({ peakEndHour: Number(e.target.value) })}
            className="rounded-lg border bg-card px-1.5 py-0.5 tabular-nums outline-none focus:border-foreground/30"
          >
            {HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <span>{t('strategies.peakTimezoneLabel')}</span>
          <input
            value={tz}
            disabled={saving}
            aria-label={t('strategies.peakTimezoneLabel')}
            onChange={e => setTz(e.target.value)}
            onBlur={e => commitTimezone(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitTimezone((e.target as HTMLInputElement).value) }}
            className={`w-40 rounded-lg border bg-card px-1.5 py-0.5 outline-none focus:border-foreground/30 ${tzError ? 'border-destructive' : ''}`}
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              const local = Intl.DateTimeFormat().resolvedOptions().timeZone
              if (local) { setTz(local); commitTimezone(local) }
            }}
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {t('strategies.peakUseBrowserTimezone')}
          </button>
          {tzError && <span className="text-destructive">{t('strategies.peakTimezoneInvalid')}</span>}
          {exempt && <span className="basis-full text-muted-foreground/80">{t('strategies.peakExemptNote')}</span>}
        </div>
      )}
    </div>
  )
}
