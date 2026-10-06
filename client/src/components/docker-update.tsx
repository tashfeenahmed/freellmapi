import { useState } from 'react'
import { Loader2, RotateCw } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { fetchLatestIndex, isNewBuild, loadedEntryScript } from '@/lib/new-build'
import { useI18n } from '@/i18n'

const POLL_MS = 3000
const GIVE_UP_MS = 5 * 60 * 1000

type Phase = 'idle' | 'starting' | 'waiting' | 'failed' | 'timeout'

/**
 * Docker "Update now": the server asks its Watchtower sidecar to pull the new
 * image and recreate the container (POST /api/update/apply), which takes this
 * server down mid-session. The page then polls for index.html and reloads
 * once the server is back — on a new build, or after it was seen restarting.
 */
export function DockerUpdateNow() {
  const { t } = useI18n()
  const [phase, setPhase] = useState<Phase>('idle')

  async function start() {
    setPhase('starting')
    try {
      await apiFetch('/api/update/apply', { method: 'POST' })
    } catch {
      setPhase('failed')
      return
    }
    setPhase('waiting')
    const loaded = loadedEntryScript()
    const started = Date.now()
    let wentDown = false
    while (Date.now() - started < GIVE_UP_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
      try {
        const html = await fetchLatestIndex()
        if (isNewBuild(loaded, html) || wentDown) {
          window.location.reload()
          return
        }
      } catch {
        wentDown = true
      }
    }
    setPhase('timeout')
  }

  const busy = phase === 'starting' || phase === 'waiting'
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCw className="size-4" aria-hidden />}
        {t('settings.updateNow')}
      </button>
      {phase === 'waiting' && <p className="text-[11px] text-muted-foreground">{t('settings.updatingContainer')}</p>}
      {phase === 'failed' && <p role="alert" className="text-xs text-destructive">{t('settings.updateNowFailed')}</p>}
      {phase === 'timeout' && <p role="alert" className="text-xs text-destructive">{t('settings.updateNowTimeout')}</p>}
    </div>
  )
}
