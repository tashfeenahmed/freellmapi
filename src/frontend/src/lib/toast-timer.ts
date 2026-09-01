// Pausable countdown behind a toast's auto-dismiss (#586). The Toaster pauses
// it while the pointer is over the toast and while the window is blurred, so
// reading a message never races the timer. Pauses are counted, not boolean:
// hover and blur can overlap, and the timer only runs when every hold has
// been released. Kept free of React/DOM so it can be unit-tested directly.

export interface ToastTimer {
  /** Suspend the countdown; keeps the remaining time. */
  pause(): void
  /** Release one pause hold; the countdown resumes once none remain. */
  resume(): void
  /** Stop for good without firing (unmount / manual dismiss). */
  cancel(): void
}

export function startToastTimer(durationMs: number, onExpire: () => void): ToastTimer {
  let remaining = durationMs
  let startedAt: number | null = null
  let timeout: ReturnType<typeof setTimeout> | undefined
  let holds = 0
  let finished = false

  const expire = () => {
    finished = true
    startedAt = null
    timeout = undefined
    onExpire()
  }

  const run = () => {
    if (finished || holds > 0 || startedAt !== null) return
    startedAt = Date.now()
    timeout = setTimeout(expire, Math.max(0, remaining))
  }

  const halt = () => {
    if (startedAt !== null) {
      remaining -= Date.now() - startedAt
      startedAt = null
    }
    if (timeout !== undefined) {
      clearTimeout(timeout)
      timeout = undefined
    }
  }

  run()
  return {
    pause() {
      holds++
      halt()
    },
    resume() {
      if (holds > 0) holds--
      run()
    },
    cancel() {
      finished = true
      halt()
    },
  }
}
