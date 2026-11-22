// @vitest-environment jsdom
//
// Regression tests for #2024: per-model "On" switches on Models > Chat models
// (FallbackPage) must persist immediately via PUT /api/fallback and survive a
// reload/remount, rather than only staging in local state with no network write.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import FallbackPage from './FallbackPage'
import type { FallbackEntry } from '@/lib/routing'

if (!globalThis.localStorage) {
  const store = new Map<string, string>()
  // @ts-expect-error minimal jsdom shim
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
}

const apiFetchMock = vi.fn()
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

// Stub secondary sections on FallbackPage so the test focuses on the table's
// per-model "On" switches and their PUT /api/fallback persistence.
vi.mock('@/components/getting-started', () => ({ GettingStarted: () => null }))
vi.mock('@/components/chain-manager', () => ({ ChainManager: () => null }))
vi.mock('@/components/penalty-inspector', () => ({ PenaltyInspector: () => null }))
vi.mock('@/components/reliability-floor-control', () => ({ ReliabilityFloorControl: () => null }))
vi.mock('@/components/provider-moment-control', () => ({ ProviderMomentControl: () => null }))

function makeEntry(overrides: Partial<FallbackEntry> & { modelDbId: number; modelId: string; displayName: string }): FallbackEntry {
  return {
    priority: overrides.modelDbId,
    effectivePriority: overrides.modelDbId,
    penalty: 0,
    rateLimitHits: 0,
    enabled: false,
    platform: 'google',
    intelligenceRank: 1,
    speedRank: 1,
    sizeLabel: 'Large',
    rpmLimit: null,
    rpdLimit: null,
    monthlyTokenBudget: '0',
    contextWindow: 128_000,
    supportsVision: false,
    supportsTools: true,
    keyCount: 1,
    ...overrides,
  }
}

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  apiFetchMock.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function mountPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <MemoryRouter initialEntries={['/models/chat']}>
            <FallbackPage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  await vi.waitFor(() => {
    expect(getSwitches().length).toBeGreaterThan(0)
  })
  return client
}

function getSwitches(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[data-slot="switch"]')) as HTMLButtonElement[]
}

describe('FallbackPage per-model "On" switch persistence (#2024)', () => {
  it('sends PUT /api/fallback immediately when toggled and survives a reload', async () => {
    let serverEntries: FallbackEntry[] = [
      makeEntry({ modelDbId: 101, modelId: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', priority: 1, enabled: false }),
      makeEntry({ modelDbId: 102, modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', priority: 2, enabled: true }),
    ]
    const putPayloads: Array<{ modelDbId: number; priority: number; enabled: boolean }[]> = []

    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/profiles/active') return { activeProfileId: 7 }
      if (url === '/api/fallback?profile=7' && (!init || !init.method || init.method === 'GET')) {
        return serverEntries.map(e => ({ ...e }))
      }
      if (url === '/api/fallback?profile=7' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { modelDbId: number; priority: number; enabled: boolean }[]
        putPayloads.push(body)
        const byId = new Map(body.map(item => [item.modelDbId, item]))
        serverEntries = serverEntries.map(e => {
          const updated = byId.get(e.modelDbId)
          return updated ? { ...e, priority: updated.priority, enabled: updated.enabled } : e
        })
        return { success: true }
      }
      if (url === '/api/fallback/routing') return { strategy: 'balanced', scores: [] }
      if (url === '/api/fallback/token-usage') return { totalBudget: 0, totalUsed: 0, models: [] }
      if (url === '/api/fallback/rate-limit-usage') return { rows: [] }
      return {}
    })

    await mountPage()
    const switchesBefore = getSwitches()
    expect(switchesBefore).toHaveLength(2)
    expect(switchesBefore[0].getAttribute('aria-checked')).toBe('false')
    expect(switchesBefore[1].getAttribute('aria-checked')).toBe('true')

    // Click the first model's "On" switch — no separate Save click required.
    act(() => { switchesBefore[0].click() })
    await flush()

    // Only the clicked row, at its saved priority, pinned to the shown chain.
    expect(putPayloads).toHaveLength(1)
    expect(putPayloads[0]).toEqual([{ modelDbId: 101, priority: 1, enabled: true }])
    expect(container.textContent).not.toContain('Save changes')

    // Simulate a full page reload / app restart with a fresh QueryClient.
    act(() => root.unmount())
    root = createRoot(container)
    await mountPage()

    const switchesAfter = getSwitches()
    expect(switchesAfter).toHaveLength(2)
    expect(switchesAfter[0].getAttribute('aria-checked')).toBe('true')
    expect(switchesAfter[1].getAttribute('aria-checked')).toBe('true')
  })

  it('preserves all toggles when two switches are clicked before the first PUT settles', async () => {
    let serverEntries: FallbackEntry[] = [
      makeEntry({ modelDbId: 101, modelId: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', priority: 1, enabled: false }),
      makeEntry({ modelDbId: 102, modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', priority: 2, enabled: true }),
    ]
    const pendingPuts: Array<() => void> = []

    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/profiles/active') return { activeProfileId: 7 }
      if (url === '/api/fallback?profile=7' && (!init || !init.method || init.method === 'GET')) {
        return serverEntries.map(e => ({ ...e }))
      }
      if (url === '/api/fallback?profile=7' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { modelDbId: number; priority: number; enabled: boolean }[]
        await new Promise<void>(resolve => {
          pendingPuts.push(() => {
            const byId = new Map(body.map(item => [item.modelDbId, item]))
            serverEntries = serverEntries.map(e => {
              const updated = byId.get(e.modelDbId)
              return updated ? { ...e, priority: updated.priority, enabled: updated.enabled } : e
            })
            resolve()
          })
        })
        return { success: true }
      }
      if (url === '/api/fallback/routing') return { strategy: 'balanced', scores: [] }
      if (url === '/api/fallback/token-usage') return { totalBudget: 0, totalUsed: 0, models: [] }
      if (url === '/api/fallback/rate-limit-usage') return { rows: [] }
      return {}
    })

    await mountPage()
    const switches = getSwitches()

    // Click switch 1 (off -> on) and immediately click switch 2 (on -> off).
    act(() => { switches[0].click() })
    await flush(2)
    act(() => { getSwitches()[1].click() })
    await flush(2)

    // Resolve the queued PUTs in order.
    while (pendingPuts.length > 0) {
      const next = pendingPuts.shift()!
      act(() => next())
      await flush(3)
    }

    expect(serverEntries.find(e => e.modelDbId === 101)?.enabled).toBe(true)
    expect(serverEntries.find(e => e.modelDbId === 102)?.enabled).toBe(false)
  })

  it('rolls back the switch state if PUT /api/fallback fails', async () => {
    const serverEntries: FallbackEntry[] = [
      makeEntry({ modelDbId: 101, modelId: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', priority: 1, enabled: false }),
    ]

    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/profiles/active') return { activeProfileId: 7 }
      if (url === '/api/fallback?profile=7' && (!init || !init.method || init.method === 'GET')) {
        return serverEntries.map(e => ({ ...e }))
      }
      if (url === '/api/fallback?profile=7' && init?.method === 'PUT') {
        throw new Error('server unavailable')
      }
      if (url === '/api/fallback/routing') return { strategy: 'balanced', scores: [] }
      if (url === '/api/fallback/token-usage') return { totalBudget: 0, totalUsed: 0, models: [] }
      if (url === '/api/fallback/rate-limit-usage') return { rows: [] }
      return {}
    })

    await mountPage()
    expect(getSwitches()[0].getAttribute('aria-checked')).toBe('false')

    act(() => { getSwitches()[0].click() })
    await flush()

    expect(getSwitches()[0].getAttribute('aria-checked')).toBe('false')
  })
  it('lands rapid clicks on one switch in click order', async () => {
    let serverEntries: FallbackEntry[] = [
      makeEntry({ modelDbId: 101, modelId: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', priority: 1, enabled: false }),
    ]
    const pendingPuts: Array<() => void> = []
    let concurrent = 0
    let maxConcurrent = 0

    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/profiles/active') return { activeProfileId: 7 }
      if (url === '/api/fallback?profile=7' && (!init || !init.method || init.method === 'GET')) {
        return serverEntries.map(e => ({ ...e }))
      }
      if (url === '/api/fallback?profile=7' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { modelDbId: number; enabled: boolean }[]
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise<void>(resolve => pendingPuts.push(() => {
          serverEntries = serverEntries.map(e => (e.modelDbId === body[0].modelDbId ? { ...e, enabled: body[0].enabled } : e))
          concurrent -= 1
          resolve()
        }))
        return { success: true }
      }
      if (url === '/api/fallback/routing') return { strategy: 'balanced', scores: [] }
      if (url === '/api/fallback/token-usage') return { totalBudget: 0, totalUsed: 0, models: [] }
      if (url === '/api/fallback/rate-limit-usage') return { rows: [] }
      return {}
    })

    await mountPage()
    // on, off, on: three writes for the same row, the last one must win.
    for (let i = 0; i < 3; i++) {
      act(() => { getSwitches()[0].click() })
      await flush(2)
    }
    expect(getSwitches()[0].getAttribute('aria-checked')).toBe('true')
    while (pendingPuts.length > 0 || concurrent > 0) {
      const next = pendingPuts.shift()
      if (next) act(() => next())
      await flush(3)
    }
    expect(maxConcurrent).toBe(1)
    expect(serverEntries[0].enabled).toBe(true)
    expect(getSwitches()[0].getAttribute('aria-checked')).toBe('true')
  })

  it('keeps an unsaved bulk edit staged instead of committing it with a switch', async () => {
    const serverEntries: FallbackEntry[] = [
      makeEntry({ modelDbId: 101, modelId: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', priority: 1, enabled: true }),
      makeEntry({ modelDbId: 102, modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', priority: 2, enabled: true }),
      makeEntry({ modelDbId: 103, modelId: 'gemma-4', displayName: 'Gemma 4', priority: 3, enabled: true }),
    ]
    const putPayloads: Array<{ modelDbId: number; priority: number; enabled: boolean }[]> = []

    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/profiles/active') return { activeProfileId: 7 }
      if (url === '/api/fallback?profile=7' && (!init || !init.method || init.method === 'GET')) {
        return serverEntries.map(e => ({ ...e }))
      }
      if (url.startsWith('/api/fallback') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { modelDbId: number; priority: number; enabled: boolean }[]
        putPayloads.push(body)
        for (const item of body) {
          const row = serverEntries.find(e => e.modelDbId === item.modelDbId)
          if (row) row.enabled = item.enabled
        }
        return { success: true }
      }
      if (url === '/api/fallback/routing') return { strategy: 'balanced', scores: [] }
      if (url === '/api/fallback/token-usage') return { totalBudget: 0, totalUsed: 0, models: [] }
      if (url === '/api/fallback/rate-limit-usage') return { rows: [] }
      return {}
    })

    await mountPage()
    // "Disable all" stages every row off and shows the Save bar.
    const disableAll = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Disable all')!
    act(() => { disableAll.click() })
    await flush()
    expect(putPayloads).toHaveLength(0)
    expect(container.textContent).toContain('Save changes')

    // Turning one model back on saves that one row only.
    act(() => { getSwitches()[0].click() })
    await flush()
    expect(putPayloads).toEqual([[{ modelDbId: 101, priority: 1, enabled: true }]])
    expect(serverEntries.map(e => e.enabled)).toEqual([true, true, true])
    // The bulk edit is still pending, with the click applied to it.
    expect(container.textContent).toContain('Save changes')
    expect(getSwitches().map(s => s.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])

    // Discarding it drops the bulk edit but not the saved click.
    const discard = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Discard')!
    act(() => { discard.click() })
    await flush()
    expect(getSwitches().map(s => s.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true'])
  })
})
