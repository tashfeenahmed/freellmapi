import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { ChevronDown, ExternalLink, KeyRound, Plus, Unlock } from 'lucide-react'
import { Tooltip } from '@/components/tooltip'
import { useI18n } from '@/i18n'
import { PLATFORMS } from './shared'

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
          {unconfigured.map(p => {
            // #1225: the checklist knew *which* providers were missing, but the
            // signup page was still one manual search away — and only surfaced
            // after opening the dialog and picking the provider. The chip gets
            // a direct link to the same URL the add-key form shows. Anchor is
            // a sibling of the chip button (nesting an <a> in a <button> is
            // invalid HTML); visually it rides inside the pill.
            const signupUrl = PLATFORMS.find(entry => entry.value === p.platform)?.url
            return (
              <span key={p.platform} className="relative inline-flex items-center">
                <Tooltip
                  text={p.keyless ? t('keys.checklistKeylessTip') : t('keys.checklistNoKeyTip')}
                >
                  <button
                    type="button"
                    onClick={() => onAddKey(p.platform)}
                    className={`inline-flex h-5 items-center gap-1 rounded-4xl border border-border pr-1.5 pl-2 text-xs font-medium whitespace-nowrap transition-all hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 ${signupUrl && !p.keyless ? 'pr-7' : ''}`}
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
                {signupUrl && !p.keyless && (
                  <a
                    href={signupUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t('keys.checklistSignupLink', { provider: p.name })}
                    aria-label={t('keys.checklistSignupLink', { provider: p.name })}
                    className="absolute right-1 inline-flex text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground"
                  >
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                )}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
