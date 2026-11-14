import { useCallback, useEffect, useRef, useState } from 'react'

export type ReauthResult<T> = { ok: true; value: T } | { ok: false }

/**
 * The state of a "re-enter your password to get a secret" dialog (M31): the
 * typed password, the last error, whether a request is in flight, and the one
 * rule both dialogs need — once the user cancels or the dialog unmounts, the
 * request in flight is aborted and its result is dropped. Without that, the
 * copy dialog still put the plaintext key on the clipboard and the export
 * still downloaded the file after the user had closed them.
 *
 * `run` hands the request an AbortSignal and the current password. It resolves
 * `{ ok: false }` when the request failed (the error is set and the password
 * cleared, so a wrong password is fixed in place) or was canceled (nothing is
 * set). `cancel` aborts and resets the field and the error.
 */
export function useReauthSecret() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef<AbortController | null>(null)
  useEffect(() => () => inFlight.current?.abort(), [])

  const cancel = useCallback(() => {
    inFlight.current?.abort()
    inFlight.current = null
    setBusy(false)
    setPassword('')
    setError(null)
  }, [])

  const run = useCallback(async <T,>(
    request: (signal: AbortSignal, password: string) => Promise<T>,
  ): Promise<ReauthResult<T>> => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setBusy(true)
    setError(null)
    try {
      const value = await request(controller.signal, password)
      return controller.signal.aborted ? { ok: false } : { ok: true, value }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError((err as Error).message)
        setPassword('')
      }
      return { ok: false }
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null
        setBusy(false)
      }
    }
  }, [password])

  return { password, setPassword, error, setError, busy, run, cancel }
}
