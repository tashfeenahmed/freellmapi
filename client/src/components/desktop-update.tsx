import { useEffect } from 'react'
import { Download, Loader2, RotateCw } from 'lucide-react'
import { useI18n } from '@/i18n'
import type { DesktopUpdater } from '@/lib/desktop-updater'

/**
 * Download → progress → "Restart to update" for the desktop app. Shared by the
 * Settings update dialog and the update reminder so both drive the same
 * main-process updater. A check is started on mount when none has run yet, so
 * the buttons reflect the release the updater itself sees (latest*.yml).
 */
export function DesktopUpdateActions({ updater }: { updater: DesktopUpdater }) {
  const { t } = useI18n()
  const { state } = updater

  useEffect(() => {
    if (state.phase === 'idle') void updater.check()
    // Only on mount: a later 'current' or 'error' is an answer, not a prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const button = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60'

  return (
    <div className="space-y-2">
      {state.phase === 'available' && (
        <button type="button" className={button} onClick={() => void updater.download()}>
          <Download className="size-4" aria-hidden />
          {t('settings.downloadUpdate')}
        </button>
      )}
      {(state.phase === 'idle' || state.phase === 'checking') && (
        <button type="button" className={button} disabled>
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('keys.checking')}
        </button>
      )}
      {state.phase === 'downloading' && (
        <div className="space-y-1.5">
          <button type="button" className={button} disabled>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t('settings.downloadingUpdate', { percent: state.percent })}
          </button>
          <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={state.percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-primary transition-[width]" style={{ width: `${state.percent}%` }} />
          </div>
        </div>
      )}
      {state.phase === 'ready' && (
        <>
          <button type="button" className={button} onClick={() => void updater.install()}>
            <RotateCw className="size-4" aria-hidden />
            {t('settings.restartToUpdate')}
          </button>
          <p className="text-[11px] text-muted-foreground">{t('settings.updateReadyHint')}</p>
        </>
      )}
      {state.phase === 'error' && (
        <p role="alert" className="break-words text-xs text-destructive [overflow-wrap:anywhere]">
          {t('settings.updateInstallFailed')} {state.message}
        </p>
      )}
    </div>
  )
}
