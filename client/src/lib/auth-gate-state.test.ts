import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deriveGate,
  repairTransition,
  withTimeout,
  type AuthStatus,
  type RepairEvent,
  type RepairPhase,
} from './auth-gate-state'

describe('repairTransition', () => {
  // Every phase x event. Anything not listed as a move leaves the phase alone.
  const moves: Record<RepairPhase, Partial<Record<RepairEvent, RepairPhase>>> = {
    idle: { start: 'running' },
    running: { succeeded: 'idle', failed: 'failed' },
    failed: { retry: 'idle' },
  }
  const events: RepairEvent[] = ['start', 'succeeded', 'failed', 'retry']

  for (const phase of Object.keys(moves) as RepairPhase[]) {
    for (const event of events) {
      const expected = moves[phase][event] ?? phase
      it(`${phase} + ${event} -> ${expected}`, () => {
        expect(repairTransition(phase, event)).toBe(expected)
      })
    }
  }
})

describe('deriveGate', () => {
  const status = (s: Partial<AuthStatus>): AuthStatus =>
    ({ needsSetup: false, authenticated: false, email: null, ...s })
  const base = { isLoading: false, desktopCapable: false, repair: 'idle' as RepairPhase }

  it('is loading while the first status fetch runs', () => {
    expect(deriveGate({ ...base, isLoading: true, status: undefined })).toBe('loading')
  })

  it('is unreachable only when no status ever loaded', () => {
    expect(deriveGate({ ...base, status: undefined })).toBe('unreachable')
  })

  it('maps a status to setup, login or the app', () => {
    expect(deriveGate({ ...base, status: status({ needsSetup: true }) })).toBe('setup')
    expect(deriveGate({ ...base, status: status({}) })).toBe('login')
    expect(deriveGate({ ...base, status: status({ authenticated: true }) })).toBe('app')
  })

  it('never shows a form on a desktop install without a session', () => {
    const desktop = { ...base, desktopCapable: true }
    for (const s of [status({}), status({ needsSetup: true })]) {
      expect(deriveGate({ ...desktop, status: s, repair: 'idle' })).toBe('desktopRepairing')
      expect(deriveGate({ ...desktop, status: s, repair: 'running' })).toBe('desktopRepairing')
      expect(deriveGate({ ...desktop, status: s, repair: 'failed' })).toBe('desktopRepairFailed')
    }
    expect(deriveGate({ ...desktop, status: status({ authenticated: true }) })).toBe('app')
  })
})

describe('withTimeout', () => {
  afterEach(() => { vi.useRealTimers() })

  it('passes the value through when it arrives in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'x')).resolves.toBe('ok')
  })

  it('rejects when the promise never settles', async () => {
    vi.useFakeTimers()
    const pending = withTimeout(new Promise<string>(() => {}), 1_000, 'desktop session')
    const assertion = expect(pending).rejects.toThrow('desktop session timed out after 1000 ms')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })
})
