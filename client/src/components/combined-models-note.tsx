import { useState } from 'react'
import { Layers, X } from 'lucide-react'
import { useI18n } from '@/i18n'

const DISMISS_KEY = 'models.combinedNoteDismissed'

// One-time, dismissible note explaining that a model served by several providers
// now shows as a single combined entry that fails over across its providers.
// Shown on the Models page while unification is on; remembered in localStorage.
export function CombinedModelsNote() {
  const { t } = useI18n()
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })
  if (dismissed) return null

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ }
    setDismissed(true)
  }

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4">
      <Layers className="mt-0.5 size-5 shrink-0 text-violet-500" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('models.combinedNoteTitle')}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('models.combinedNoteBody')}</p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('models.combinedNoteDismiss')}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
