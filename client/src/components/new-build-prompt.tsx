import { useEffect, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { useI18n } from '@/i18n'
import { fetchLatestIndex, isNewBuild, loadedEntryScript } from '@/lib/new-build'

/** At most one same-origin index.html fetch per minute, however often the tab
 *  regains focus; a tab left in the foreground re-checks every five. */
const MIN_GAP_MS = 60 * 1000
const POLL_MS = 5 * 60 * 1000

/**
 * "A newer dashboard is installed — Reload." The server can be replaced under
 * an open tab (docker compose pull, a source rebuild, a demo-box deploy); the
 * tab keeps running the old bundle and fails the moment it lazy-loads a chunk
 * the new build deleted. This only ever asks this server for its own
 * index.html — nothing leaves the install.
 */
export function NewBuildPrompt() {
  const { t } = useI18n()
  const [stale, setStale] = useState(false)

  useEffect(() => {
    const loaded = loadedEntryScript()
    if (!loaded || !loaded.includes('/assets/')) return // dev server
    let lastCheck = Date.now()
    let cancelled = false

    async function check() {
      if (cancelled || document.visibilityState !== 'visible') return
      if (Date.now() - lastCheck < MIN_GAP_MS) return
      lastCheck = Date.now()
      try {
        const html = await fetchLatestIndex()
        if (!cancelled && isNewBuild(loaded, html)) setStale(true)
      } catch { /* server restarting — try again on the next focus */ }
    }

    const onWake = () => { void check() }
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    const timer = window.setInterval(onWake, POLL_MS)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
      window.clearInterval(timer)
    }
  }, [])

  if (!stale) return null
  return (
    <div
      role="status"
      className="fixed top-16 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border bg-card py-1.5 ps-4 pe-1.5 text-sm shadow-lg ring-1 ring-foreground/10"
    >
      <span className="truncate">{t('update.newBuild')}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <RotateCw className="size-3.5" aria-hidden />
        {t('update.reload')}
      </button>
    </div>
  )
}
