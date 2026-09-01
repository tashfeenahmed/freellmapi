import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Sparkles, X } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Markdown } from '@/components/markdown'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

const RELEASES_URL = 'https://github.com/tashfeenahmed/freellmapi/releases'

/** How often this browser may ask the server, so a dashboard left open in a
 *  tab isn't re-checking on every navigation. The server caches the upstream
 *  answer for six hours on top of this, and does not call GitHub at all while
 *  the check is switched off. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const STORAGE_KEY = 'freellmapi.update_reminder'

/** Fired by Settings when the opt-in is toggled, so the pill appears or
 *  disappears there and then instead of on the next reload. */
export const UPDATE_CHECK_CHANGED_EVENT = 'freellmapi:update-check-changed'

/** The server's mapped shape (GET /api/update/release). */
interface LatestRelease {
  tagName: string
  body: string | null
  htmlUrl: string
  publishedAt: string | null
}

type ReleaseResponse = LatestRelease | { disabled: true }

interface StoredCheck {
  checkedAt: number
  release: LatestRelease | null
  dismissedTag: string | null
}

/**
 * Compare two dotted versions; > 0 when `a` is newer. Missing parts read as 0,
 * and so does anything that isn't a leading integer — `1.2.0-rc1` compares as
 * `1.2.0`, which is wrong in the pre-release direction but never throws and
 * never invents an update out of a tag it cannot read.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function readStored(): StoredCheck | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) as StoredCheck : null
  } catch {
    return null
  }
}

function writeStored(value: StoredCheck): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch { /* ignore */ }
}

/**
 * Automatic update reminder: asks the server for the latest release once a day
 * (not on every load), and when a newer version exists shows a small corner
 * pill. Clicking it opens a dialog with the release notes (what's new), a link
 * to the release page, and a per-version dismiss so a release the operator
 * already saw doesn't nag again.
 *
 * Two things are deliberately not done here. GitHub is not contacted from the
 * browser: the CSP this server sends is `connect-src 'self'`, so a direct
 * fetch to api.github.com is blocked on every install that isn't the desktop
 * shell. And nothing is checked at all until the operator opts in from
 * Settings — the server answers `{ disabled: true }` until then, and never
 * makes the outbound request.
 *
 * Unlike the wordless update row in Settings, this is an explicit notification
 * the user asked for, so it uses real i18n copy (en is the fallback for every
 * locale, and the release body itself comes untranslated from GitHub).
 */
export function UpdateReminder() {
  const { t } = useI18n()
  // Current version: the desktop shell states it outright, so it is read at
  // render rather than assigned from an effect; a browser or container install
  // asks the server. Both may be empty → no reminder.
  const shellVersion = typeof window !== 'undefined'
    ? (window as { __FREEAPI_VERSION__?: string | null }).__FREEAPI_VERSION__ ?? null
    : null
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const [release, setRelease] = useState<LatestRelease | null>(null)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const version = shellVersion ?? serverVersion
  const openRef = useRef(false)

  // Read by the async check to decide whether it may replace what the operator
  // is currently reading. Synced in an effect, not during render.
  useEffect(() => { openRef.current = open }, [open])

  // Toggling the opt-in in Settings re-runs the check immediately, bypassing
  // the day throttle: an operator who just switched it on is asking for an
  // answer now, and one who switched it off expects the pill to go away.
  useEffect(() => {
    function onChanged() { setRefresh(count => count + 1) }
    window.addEventListener(UPDATE_CHECK_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(UPDATE_CHECK_CHANGED_EVENT, onChanged)
  }, [])

  useEffect(() => {
    if (shellVersion) return
    let cancelled = false
    apiFetch<{ version: string | null }>('/api/settings/version')
      .then(r => { if (!cancelled) setServerVersion(r.version ?? null) })
      .catch(() => { /* leave hidden */ })
    return () => { cancelled = true }
  }, [shellVersion])

  // Throttled automatic check. A dialog already open is left alone; otherwise
  // the pill appears only when a genuinely newer release exists.
  useEffect(() => {
    if (!version) return
    let cancelled = false
    const currentVersion = version
    const forced = refresh > 0

    async function check() {
      try {
        const stored = readStored()
        const freshEnough = !forced
          && stored != null
          && Date.now() - stored.checkedAt < CHECK_INTERVAL_MS
          && stored.release != null

        let latest = freshEnough ? stored!.release : null

        if (!freshEnough) {
          const data = await apiFetch<ReleaseResponse>('/api/update/release')
          if (cancelled) return
          if ('disabled' in data) {
            // Opted out: drop the cached release too, or the throttle below
            // would keep showing the old pill for a day after the opt-out.
            // A null release also means the next load asks again — one
            // same-origin request that the server answers without contacting
            // anything.
            setRelease(null)
            writeStored({
              checkedAt: Date.now(),
              release: null,
              dismissedTag: stored?.dismissedTag ?? null,
            })
            return
          }
          latest = { ...data, tagName: data.tagName.replace(/^v/, '') }
          writeStored({
            checkedAt: Date.now(),
            release: latest,
            dismissedTag: stored?.dismissedTag ?? null,
          })
        }

        if (!latest || compareVersions(latest.tagName, currentVersion) <= 0) return
        if (cancelled || openRef.current) return
        setDismissed(stored?.dismissedTag ?? null)
        setRelease(latest)
      } catch { /* unreachable server or upstream failure → stay silent */ }
    }

    void check()
    return () => { cancelled = true }
  }, [version, refresh])

  // Dismissal is per version and has to survive a reload, or the pill is back
  // on the next page load for a release the operator already dealt with.
  function dismiss(tag: string) {
    setDismissed(tag)
    const stored = readStored()
    writeStored({
      checkedAt: stored?.checkedAt ?? Date.now(),
      release: stored?.release ?? null,
      dismissedTag: tag,
    })
  }

  if (!release) return null
  if (dismissed === release.tagName) return null

  const published = release.publishedAt
    ? new Date(release.publishedAt).toLocaleDateString()
    : null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 left-4 z-[60] flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm shadow-lg ring-1 ring-foreground/10 outline-none transition-all duration-150 hover:scale-[1.02] hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 sm:left-6"
      >
        <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="truncate">
          {t('update.available')} <span className="font-semibold tabular-nums">v{version}</span>
          <ArrowUpRight className="ml-1 inline size-3.5" aria-hidden />
          <span className="font-semibold tabular-nums">v{release.tagName}</span>
        </span>
        <span
          role="button"
          tabIndex={0}
          aria-label={t('update.dismiss')}
          onClick={event => { event.stopPropagation(); dismiss(release.tagName) }}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation()
              dismiss(release.tagName)
            }
          }}
          className="ml-1 inline-flex shrink-0 rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <X className="size-3.5" aria-hidden />
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup maxWidth="max-w-xl">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <DialogTitle>{t('update.whatsNew', { version: release.tagName })}</DialogTitle>
              {published && (
                <DialogDescription className="mt-1">{t('update.publishedOn', { date: published })}</DialogDescription>
              )}
            </div>
            <DialogClose className="rounded-full p-1 text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
              <X className="size-4" aria-hidden />
            </DialogClose>
          </div>

          {release.body ? (
            <div className="max-h-[45vh] overflow-y-auto rounded-xl border bg-muted/20 p-4">
              <Markdown>{release.body}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('update.noNotes')}</p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <a
              href={release.htmlUrl || RELEASES_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {t('update.openRelease')}
              <ArrowUpRight className="size-4" aria-hidden />
            </a>
            <button
              type="button"
              onClick={() => dismiss(release.tagName)}
              className="rounded-lg border px-3.5 py-2 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {t('update.dismissVersion')}
            </button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  )
}
