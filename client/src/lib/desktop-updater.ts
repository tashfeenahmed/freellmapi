import { useEffect, useState } from 'react'

/** Mirrors desktop/src/update-support.ts — the main process's updater state. */
export type DesktopUpdateState =
  | { phase: 'unsupported'; reason: 'dev' | 'package' }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; checkedAt: string }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; during?: 'check' | 'download' | 'install'; message: string }

interface DesktopUpdaterBridge {
  state: () => Promise<DesktopUpdateState>
  check: () => Promise<DesktopUpdateState>
  download: () => Promise<DesktopUpdateState>
  install: () => Promise<DesktopUpdateState>
  subscribe: (listener: (state: DesktopUpdateState) => void) => () => void
}

function bridge(): DesktopUpdaterBridge | null {
  if (typeof window === 'undefined') return null
  return (window as { __FREEAPI_UPDATER__?: DesktopUpdaterBridge }).__FREEAPI_UPDATER__ ?? null
}

/** True when this page runs in a desktop build with the updater bridge. */
export function hasDesktopUpdater(): boolean {
  return bridge() !== null
}

/** Starts a desktop update check; the new state arrives through the hook. */
export function checkDesktopUpdates(): Promise<DesktopUpdateState> | null {
  return bridge()?.check() ?? null
}

/**
 * The desktop shell's in-app updater, or null in a browser and in a desktop
 * build that cannot replace itself (deb/rpm, the portable zip, a dev build) —
 * callers then keep their "open the releases page" fallback.
 */
export function useDesktopUpdater() {
  const updater = bridge()
  const [state, setState] = useState<DesktopUpdateState | null>(null)

  useEffect(() => {
    if (!updater) return
    let cancelled = false
    void updater.state().then(next => { if (!cancelled) setState(next) })
    const unsubscribe = updater.subscribe(next => setState(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [updater])

  if (!updater || !state || state.phase === 'unsupported') return null
  return {
    state,
    check: () => updater.check().then(next => { setState(next); return next }),
    download: () => updater.download().then(next => { setState(next); return next }),
    install: () => updater.install().then(next => { setState(next); return next }),
  }
}

export type DesktopUpdater = NonNullable<ReturnType<typeof useDesktopUpdater>>
