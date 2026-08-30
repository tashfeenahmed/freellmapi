import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { ChevronDown, KeyRound, Plus, Unlock } from 'lucide-react'
import { Tooltip } from '@/components/tooltip'
import { useI18n } from '@/i18n'

// Shape of GET /api/keys/providers (#543). Declared inline: the backend owns
// the contract (server/src/routes/keys.ts) and this is the only consumer.
interface ProviderChecklistEntry {
  platform: string
  name: string
  keyless: boolean
  configured: boolean
  keyCount: number
  enabledKeyCount: number
}
interface ProvidersChecklist {
  providers: ProviderChecklistEntry[]
  summary: { total: number; configured: number; unconfigured: number }
}

// One-line coverage strip above the key manager (#543): "22 of 31 providers
// configured", expandable to compact chips for the providers still missing a
// key. Deliberately slim — a single line of secondary text, not a card — so
// the key manager stays the first thing on the page. Clicking a chip opens
// the Add key dialog preselected to that provider.
export function ProviderChecklistSection({ onAddKey }: { onAddKey: (platform: string) => void }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const { data } = useQuery<ProvidersChecklist>({
    queryKey: ['keys-providers'],
    queryFn: () => apiFetch('/api/keys/providers'),
  })

  // No skeleton: the strip is one line of muted text, so it simply appears
  // once loaded instead of reserving space while the page settles.
  if (!data || data.providers.length === 0) return null

  const unconfigured = data.providers.filter(p => !p.configured)
  const summaryText = t('keys.checklistSummary', {
    configured: data.summary.configured,
    total: data.summary.total,
  })

  // Everything configured: nothing actionable to expand, just the summary.
  if (unconfigured.length === 0) {
    return <p className="text-xs text-muted-foreground">{summaryText}</p>
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {summaryText}
        <ChevronDown className={`size-3.5 transition-transform ${expanded ? '' : '-rotate-90'}`} />
      </button>
      {expanded && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {unconfigured.map(p => (
            // The status reads as an icon, not a word: the chip row is dense and
            // the labels repeated on every chip. The wrapper is the shared
            // Tooltip, which opens on hover and — because focus bubbles up from
            // the button inside it — on keyboard focus too, so the sentence the
            // icon replaces is still one hover or one Tab away. The short label
            // stays as sr-only text, keeping the button's accessible name.
            <Tooltip
              key={p.platform}
              text={p.keyless ? t('keys.checklistKeylessTip') : t('keys.checklistNoKeyTip')}
            >
              <button
                type="button"
                onClick={() => onAddKey(p.platform)}
                className="inline-flex h-5 items-center gap-1 rounded-4xl border border-border px-2 text-xs font-medium whitespace-nowrap transition-all hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Plus className="size-3 text-muted-foreground" />
                {p.name}
                {p.keyless ? (
                  <span className="inline-flex text-muted-foreground">
                    <Unlock className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">{t('keys.checklistKeyless')}</span>
                  </span>
                ) : (
                  // Needs a key but none added yet — the actionable case. Amber
                  // so the "add this" providers stand out from anonymous ones.
                  <span className="inline-flex text-amber-600 dark:text-amber-400">
                    <KeyRound className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">{t('models.noKey')}</span>
                  </span>
                )}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  )
}
