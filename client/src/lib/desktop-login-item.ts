import { useCallback, useEffect, useState } from 'react'

/** The desktop shell's login-item ("Start on system startup") bridge. */
interface DesktopLoginItemBridge {
  get: () => Promise<boolean>
  set: (open: boolean) => Promise<unknown>
}

function bridge(): DesktopLoginItemBridge | null {
  if (typeof window === 'undefined') return null
  return (window as { __FREEAPI_LOGIN_ITEM__?: DesktopLoginItemBridge }).__FREEAPI_LOGIN_ITEM__ ?? null
}

/** True when this page runs in a desktop build that exposes the login-item bridge. */
export function hasDesktopLoginItem(): boolean {
  return bridge() !== null
}

/**
 * The OS-level "Start on system startup" flag. Returns `enabled: null` until
 * the first read resolves (and permanently in a browser, where there is no
 * desktop shell) so callers can hide the control until it has a real value.
 */
export function useDesktopLoginItem() {
  const item = bridge()
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    if (!item) return
    let cancelled = false
    void item.get().then(next => { if (!cancelled) setEnabled(next) })
    return () => { cancelled = true }
  }, [item])

  const toggle = useCallback(async (next: boolean) => {
    if (!item) return
    const previous = enabled
    setEnabled(next)
    try {
      await item.set(next)
    } catch {
      // The OS refused the change (or the IPC failed) — restore the last known state.
      setEnabled(previous)
    }
  }, [item, enabled])

  return { enabled, toggle }
}
