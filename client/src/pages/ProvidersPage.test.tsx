// @vitest-environment jsdom
// The Providers page: free-only banner, verification wording, routing
// eligibility, add-key deep link, and actions on the existing endpoints.
import { afterEach, beforeAll, beforeEach, expect, it, vi, describe } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import ProvidersPage from './ProvidersPage'
import { visibleProviders, type ProviderOverview, type ProvidersResponse } from '@/lib/providers-view'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiFetch }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function provider(overrides: Partial<ProviderOverview> & Pick<ProviderOverview, 'platform' | 'name' | 'state'>): ProviderOverview {
  return {
    kind: 'chat',
    keyless: false,
    credentialsRequired: true,
    metadata: {
      freeTier: 'free-recurring', confidence: 'medium', summary: 'summary', restrictions: [],
      docsUrl: null, docsUrlSource: null, quotasPublished: 'yes',
    },
    verification: { status: 'repo-documented', verifiedOn: null },
    automaticRouting: { eligible: true },
    keys: { total: 0, items: [] },
    lastCheckedAt: null,
    models: { enabled: 3, automaticallyRoutable: 3 },
    traffic24h: { requests: 0, successRate: null, avgLatencyMs: null },
    cooldowns: { active: 0, soonestExpiresAt: null },
    providerReportedQuota: [],
    ...overrides,
  }
}

const RESPONSE: ProvidersResponse = {
  freeOnly: { enabled: true, optedIn: [{ platform: 'sail', warning: 'paid-beyond-free access can consume credit or be billed' }] },
  providers: [
    provider({ platform: 'mistral', name: 'Mistral', state: 'unconfigured' }),
    provider({
      platform: 'google', name: 'Google AI Studio', state: 'connected',
      keys: { total: 1, items: [{ id: 7, label: 'main', status: 'healthy', enabled: true, lastCheckedAt: '2026-10-28 12:00:00', lastHealthError: null }] },
      traffic24h: { requests: 4, successRate: 0.75, avgLatencyMs: 3186 },
      metadata: {
        freeTier: 'free-recurring', confidence: 'medium', summary: 'Gemini free tier', restrictions: ['per project'],
        docsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits', docsUrlSource: 'unchecked', quotasPublished: 'partial',
      },
    }),
    provider({
      platform: 'cohere', name: 'Cohere', state: 'unhealthy',
      metadata: { freeTier: 'trial', confidence: 'medium', summary: 'trial', restrictions: [], docsUrl: null, docsUrlSource: null, quotasPublished: 'yes' },
      automaticRouting: { eligible: false, reason: 'trial access; set FREE_ONLY_ALLOW_PLATFORMS=cohere to opt in' },
      keys: { total: 1, items: [{ id: 9, label: null, status: 'invalid', enabled: true, lastCheckedAt: null, lastHealthError: 'invalid api key' }] },
    }),
    provider({ platform: 'tavily', name: 'Tavily', state: 'unconfigured', kind: 'search' }),
  ],
}

let root: Root
let container: HTMLDivElement
beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(async (path: string) => (path === '/api/providers' ? RESPONSE : {}))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div> }

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={['/models/providers']}>
          <Routes>
            <Route path="/models/providers" element={<ProvidersPage />} />
            <Route path="/keys" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  ))
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

const card = (platform: string) => container.querySelector(`[data-testid="provider-${platform}"]`) as HTMLElement | null

describe('ProvidersPage', () => {
  it('shows chat providers ordered by state and hides search APIs', async () => {
    await mount()
    const order = [...container.querySelectorAll('[data-testid^="provider-"]')].map(el => el.getAttribute('data-testid'))
    expect(order).toEqual(['provider-google', 'provider-cohere', 'provider-mistral'])
  })

  it('states the free-only policy, opt-in warnings, and that a key check is not a quota measurement', async () => {
    await mount()
    const banner = container.querySelector('[data-testid="free-only-banner"]')!.textContent!
    expect(banner).toMatch(/Free-only routing is on/)
    expect(banner).toMatch(/sail is opted in/)
    expect(banner).toMatch(/does not measure remaining quota/)
  })

  it('never presents repository notes as verified documentation', async () => {
    await mount()
    const verification = card('google')!.querySelector('[data-testid="verification"]')!.textContent!
    expect(verification).toMatch(/not checked against official docs/)
    expect(verification).toMatch(/link not checked/)
    expect(card('google')!.querySelector('[data-testid="quota"]')!.textContent).toBe('not measured')
  })

  it('explains why a provider is not used automatically', async () => {
    await mount()
    expect(card('cohere')!.querySelector('[data-testid="auto-routing"]')!.textContent).toMatch(/Not used automatically: trial access/)
    expect(card('google')!.querySelector('[data-testid="auto-routing"]')!.textContent).toMatch(/3 of 3 enabled models/)
  })

  it('offers to add a key for an unconfigured provider via the Keys page', async () => {
    await mount()
    const link = card('mistral')!.querySelector('a') as HTMLAnchorElement
    expect(link.textContent).toBe('Add your key')
    await act(async () => { link.click() })
    expect(container.querySelector('[data-testid="where"]')!.textContent).toBe('/keys?add=mistral')
  })

  it('tests and toggles keys through the existing endpoints', async () => {
    await mount()
    const test = [...card('google')!.querySelectorAll('button')].find(b => b.textContent?.includes('Test'))!
    await act(async () => { test.click() })
    expect(apiFetch).toHaveBeenCalledWith('/api/health/check/7', { method: 'POST' })
    const toggle = card('google')!.querySelector('[role="switch"]') as HTMLElement
    await act(async () => { toggle.click() })
    expect(apiFetch).toHaveBeenCalledWith('/api/keys/7', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
  })

  it('resyncs the catalog and checks all keys with the existing endpoints', async () => {
    await mount()
    const buttons = [...container.querySelectorAll('button')]
    await act(async () => { buttons.find(b => b.textContent?.includes('Resync catalog'))!.click() })
    await act(async () => { buttons.find(b => b.textContent?.includes('Check all keys'))!.click() })
    expect(apiFetch).toHaveBeenCalledWith('/api/premium/sync', { method: 'POST' })
    expect(apiFetch).toHaveBeenCalledWith('/api/health/check-all', { method: 'POST' })
  })
})

describe('visibleProviders', () => {
  it('filters by state and search text', () => {
    expect(visibleProviders(RESPONSE.providers, 'unconfigured', '').map(p => p.platform)).toEqual(['mistral'])
    expect(visibleProviders(RESPONSE.providers, 'all', 'goo').map(p => p.platform)).toEqual(['google'])
    expect(visibleProviders(RESPONSE.providers, 'all', '').some(p => p.kind === 'search')).toBe(false)
  })
})
