import { useEffect, useState, type ReactNode } from 'react'
import { AlertCircle, ArrowUpRight, CheckCircle2, Info, Loader2, Sparkles, X } from 'lucide-react'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { CopyButton } from '@/components/copy-button'
import { UPDATE_CHECK_CHANGED_EVENT } from '@/components/update-reminder'
import { apiFetch } from '@/lib/api'
import { checkDesktopUpdates, hasDesktopUpdater, useDesktopUpdater } from '@/lib/desktop-updater'
import { useDockerUpdate } from '@/lib/docker-update'
import { RELEASES_URL } from '@/lib/updates'
import { useI18n } from '@/i18n'

type Installation = 'source' | 'docker' | 'desktop' | 'unknown'

interface CheckResult {
  status: 'current' | 'available' | 'ahead' | 'diverged' | 'unknown' | 'unsupported' | 'disabled'
  installation: Installation
  localSha: string | null
  version: string | null
  selfUpdate?: boolean
}

/** Connectivity failures read better as "check your connection" than as a raw code. */
function isNetworkError(message: string): boolean {
  return /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_CONNECTION|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|network/i.test(message)
}

const DOCKER_COMMAND = 'docker compose pull && docker compose up -d'
const SOURCE_COMMAND = 'git fetch https://github.com/tashfeenahmed/freellmapi.git main && git merge --ff-only FETCH_HEAD && npm ci && npm run build'

/**
 * The one place updates live: opened from the ⋯ menu or the update pill.
 * Shows the running version, one status line and at most one action. The
 * desktop app is driven by its own updater (download → restart); every other
 * install asks the server, which compares the build with GitHub.
 */
export function UpdatesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md" className="p-0">
        {/* Mounted only while open, so every opening starts a fresh check. */}
        {open && <UpdatesContent />}
      </DialogPopup>
    </Dialog>
  )
}

function UpdatesContent() {
  const { t } = useI18n()
  const desktop = useDesktopUpdater()
  const docker = useDockerUpdate()
  const shellVersion = typeof window !== 'undefined'
    ? (window as { __FREEAPI_VERSION__?: string | null }).__FREEAPI_VERSION__ ?? null
    : null
  const [result, setResult] = useState<CheckResult | null>(null)
  const [checking, setChecking] = useState(true)
  const [failed, setFailed] = useState(false)
  const [autoCheck, setAutoCheck] = useState<boolean | null>(null)
  // Asked separately from the check, so the version still shows when it fails.
  const [serverVersion, setServerVersion] = useState<string | null>(null)

  const [attempt, setAttempt] = useState(0)

  // Runs on open and on every retry; state is only set once answers are back.
  useEffect(() => {
    let cancelled = false
    if (hasDesktopUpdater()) {
      void checkDesktopUpdates()
    } else {
      apiFetch<CheckResult>('/api/update/check')
        .then(r => { if (!cancelled) setResult(r) }, () => { if (!cancelled) setFailed(true) })
        .finally(() => { if (!cancelled) setChecking(false) })
    }
    return () => { cancelled = true }
  }, [attempt])

  useEffect(() => {
    let cancelled = false
    apiFetch<{ enabled: boolean }>('/api/settings/update-check')
      .then(r => { if (!cancelled) setAutoCheck(r.enabled) })
      .catch(() => { /* leave the switch out rather than claim a state */ })
    apiFetch<{ version: string | null }>('/api/settings/version')
      .then(r => { if (!cancelled) setServerVersion(r.version ?? null) })
      .catch(() => { /* the subtitle falls back to the bare name */ })
    return () => { cancelled = true }
  }, [])

  function retry() {
    docker.reset()
    setChecking(true)
    setFailed(false)
    setAttempt(n => n + 1)
  }

  async function toggleAutoCheck(enabled: boolean) {
    const previous = autoCheck
    setAutoCheck(enabled)
    try {
      const r = await apiFetch<{ enabled: boolean }>('/api/settings/update-check', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      })
      setAutoCheck(r.enabled)
      window.dispatchEvent(new Event(UPDATE_CHECK_CHANGED_EVENT))
    } catch {
      setAutoCheck(previous)
    }
  }

  const version = shellVersion ?? result?.version ?? serverVersion
  const subtitle = version ? `FreeLLMAPI v${version}` : result?.localSha ? `FreeLLMAPI ${result.localSha}` : 'FreeLLMAPI'
  const releaseNotes = (
    <a href={RELEASES_URL} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
      {t('updates.releaseNotes')}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  )
  const retryButton = (
    <Button size="sm" variant="outline" onClick={retry}>{t('updates.tryAgain')}</Button>
  )

  function body(): ReactNode {
    if (desktop) {
      const state = desktop.state
      switch (state.phase) {
        case 'idle':
        case 'checking':
          return <Status icon="busy" title={t('keys.checking')} />
        case 'current':
          return <Status icon="ok" title={t('settings.upToDate')} />
        case 'available':
          return (
            <Status
              icon="new"
              title={t('updates.versionAvailable', { version: state.version })}
              detail={releaseNotes}
              action={<Button size="sm" onClick={() => void desktop.download()}>{t('settings.downloadUpdate')}</Button>}
            />
          )
        case 'downloading':
          return (
            <Status icon="busy" title={t('settings.downloadingUpdate', { percent: state.percent })}>
              <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={state.percent} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-foreground/70 transition-[width]" style={{ width: `${state.percent}%` }} />
              </div>
            </Status>
          )
        case 'ready':
          return (
            <Status
              icon="new"
              title={t('updates.versionReady', { version: state.version })}
              detail={t('settings.updateReadyHint')}
              action={<Button size="sm" onClick={() => void desktop.install()}>{t('settings.restartToUpdate')}</Button>}
            />
          )
        case 'error':
          return (
            <Status
              icon="error"
              title={state.during === 'check' ? t('settings.checkFailed') : t('settings.updateInstallFailed')}
              detail={isNetworkError(state.message) ? t('updates.offline') : state.message}
              action={retryButton}
            />
          )
        default:
          return null
      }
    }

    if (checking && !result) return <Status icon="busy" title={t('keys.checking')} />
    if (failed) return <Status icon="error" title={t('settings.checkFailed')} detail={t('updates.offline')} action={retryButton} />
    if (!result) return <Status icon="busy" title={t('keys.checking')} />

    switch (result.status) {
      case 'current':
        return <Status icon="ok" title={t('settings.upToDate')} />
      case 'available':
        if (result.installation === 'docker' && result.selfUpdate) {
          if (docker.phase === 'starting' || docker.phase === 'waiting') {
            return <Status icon="busy" title={t('settings.updatingContainer')} />
          }
          if (docker.phase === 'failed' || docker.phase === 'timeout') {
            const message = docker.phase === 'failed' ? t('settings.updateNowFailed') : t('settings.updateNowTimeout')
            return <Status icon="error" title={t('settings.updateInstallFailed')} detail={message} action={retryButton} />
          }
          return (
            <Status
              icon="new"
              title={t('settings.updateAvailable')}
              detail={releaseNotes}
              action={<Button size="sm" onClick={() => void docker.start()}>{t('settings.updateNow')}</Button>}
            />
          )
        }
        if (result.installation === 'docker' || result.installation === 'source') {
          const command = result.installation === 'docker' ? DOCKER_COMMAND : SOURCE_COMMAND
          return (
            <Status icon="new" title={t('settings.updateAvailable')} detail={releaseNotes}>
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/60 py-1.5 ps-3 pe-1.5">
                <code className="min-w-0 flex-1 break-all py-1 font-mono text-[11px] text-muted-foreground">{command}</code>
                <CopyButton text={command} className="size-7 shrink-0" label={t('common.copy')} />
              </div>
              {result.installation === 'source' && (
                <p className="mt-2 text-xs text-muted-foreground">{t('settings.restartAfterUpdate')}</p>
              )}
            </Status>
          )
        }
        return (
          <Status
            icon="new"
            title={t('settings.updateAvailable')}
            action={(
              <a href={RELEASES_URL} target="_blank" rel="noreferrer noopener" className={buttonVariants({ size: 'sm' })}>
                {t('updates.releaseNotes')}
                <ArrowUpRight aria-hidden />
              </a>
            )}
          />
        )
      case 'ahead':
        return <Status icon="info" title={t('settings.buildAhead')} />
      case 'diverged':
        return <Status icon="info" title={t('settings.buildDiverged')} />
      case 'unknown':
        return <Status icon="info" title={t('settings.buildUnknown')} detail={releaseNotes} />
      default:
        return <Status icon="info" title={t('settings.notGitInstall')} detail={releaseNotes} />
    }
  }

  return (
    <>
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="min-w-0">
            <DialogTitle>{t('settings.updatesTitle')}</DialogTitle>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-me-1 rounded-lg p-1 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>
        <div aria-live="polite" className="px-5 py-4">{body()}</div>
        {autoCheck !== null && (
          <label className="flex cursor-pointer items-center justify-between gap-4 border-t px-5 py-3.5 text-sm">
            <span className="text-muted-foreground">{t('settings.autoUpdateCheck')}</span>
            <Switch
              aria-label={t('settings.autoUpdateCheck')}
              checked={autoCheck}
              onCheckedChange={checked => void toggleAutoCheck(checked)}
            />
          </label>
        )}
    </>
  )
}

const ICONS = {
  busy: <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />,
  ok: <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />,
  new: <Sparkles className="size-4 text-foreground" aria-hidden />,
  info: <Info className="size-4 text-muted-foreground" aria-hidden />,
  error: <AlertCircle className="size-4 text-destructive" aria-hidden />,
}

function Status({
  icon,
  title,
  detail,
  action,
  children,
}: {
  icon: keyof typeof ICONS
  title: string
  detail?: ReactNode
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="flex size-4 shrink-0 items-center self-start pt-0.5">{ICONS[icon]}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{title}</p>
          {detail && (
            <div className="mt-0.5 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{detail}</div>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="ps-7">{children}</div>}
    </div>
  )
}
