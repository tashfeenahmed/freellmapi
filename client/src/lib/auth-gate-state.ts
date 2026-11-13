// The dashboard's sign-in gate as one value (M25). AuthGate derives the screen
// each render from the /api/auth/status query and the desktop repair phase,
// then renders exactly that screen.

export interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
  email: string | null
  desktop?: boolean
}

export type Gate =
  | 'loading' // first status fetch in flight
  | 'unreachable' // the status never loaded
  | 'desktopRepairing' // desktop install without a valid session: fetching one
  | 'desktopRepairFailed' // the fresh session failed or was rejected too
  | 'setup'
  | 'login'
  | 'app'

// One desktop session repair at a time. A failure stays until the user retries,
// so a session the server keeps rejecting shows a message instead of looping.
export type RepairPhase = 'idle' | 'running' | 'failed'
export type RepairEvent = 'start' | 'succeeded' | 'failed' | 'retry'

export function repairTransition(phase: RepairPhase, event: RepairEvent): RepairPhase {
  switch (event) {
    case 'start': return phase === 'idle' ? 'running' : phase
    case 'succeeded': return phase === 'running' ? 'idle' : phase
    case 'failed': return phase === 'running' ? 'failed' : phase
    case 'retry': return phase === 'failed' ? 'idle' : phase
  }
}

export function deriveGate(input: {
  isLoading: boolean
  status: AuthStatus | undefined
  /** A way to mint a desktop session exists (shell bridge or desktop server). */
  desktopCapable: boolean
  repair: RepairPhase
}): Gate {
  const { isLoading, status, desktopCapable, repair } = input
  if (isLoading) return 'loading'
  // A failed background refetch keeps the last good status, so the app stays
  // up; only a status that never loaded means the server is unreachable.
  if (!status) return 'unreachable'
  if (desktopCapable && (status.needsSetup || !status.authenticated)) {
    return repair === 'failed' ? 'desktopRepairFailed' : 'desktopRepairing'
  }
  if (status.needsSetup) return 'setup'
  if (!status.authenticated) return 'login'
  return 'app'
}

// The desktop bridge is IPC to the shell; a shell that never answers must end
// in the recovery screen, not an endless spinner.
export const DESKTOP_SESSION_TIMEOUT_MS = 15_000

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
