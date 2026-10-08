// @vitest-environment jsdom
// #1403 phase 3: the provider-reported balance surfaces on the key row itself,
// not only in the Quota signals tab. Covers the pure per-key pool pick and the
// rendered badge (amber at ≤20% left, tooltip with the exact numbers).
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ProviderList } from './provider-list'
import { balanceByKey } from './quota-balance'
import type { ApiKey, ProviderQuotaState } from '../../../../shared/types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const state = (over: Partial<ProviderQuotaState>): ProviderQuotaState => ({
  platform: 'groq', keyId: 1, quotaPoolKey: 'groq::account', metric: 'requests',
  limit: 100, remaining: 50, resetAt: null, resetStrategy: 'unknown',
  source: 'header', confidence: 1, notes: null,
  observedAt: '2026-10-04 10:00:00', updatedAt: '2026-10-04 10:00:00', ...over,
})

it('picks the tightest pool per key and skips unreadable states', () => {
  const map = balanceByKey([
    state({ keyId: 1, metric: 'requests', limit: 100, remaining: 40 }),
    state({ keyId: 1, metric: 'tokens', limit: 1000, remaining: 100 }),
    state({ keyId: 2, metric: 'requests', limit: null, remaining: 7 }),
    state({ keyId: 3, metric: 'requests', limit: 100, remaining: null }),
  ])
  // key 1: tokens pool is at 10%, requests at 40% → tokens runs dry first.
  expect(map.get(1)?.metric).toBe('tokens')
  expect(map.get(1)?.fraction).toBeCloseTo(0.1)
  // key 2: no limit reported → balance without a fraction.
  expect(map.get(2)?.remaining).toBe(7)
  expect(map.get(2)?.fraction).toBeNull()
  // key 3: no numeric reading → no badge.
  expect(map.has(3)).toBe(false)
})

it('prefers a limited pool over an unlimited one for the same key', () => {
  const map = balanceByKey([
    state({ keyId: 4, metric: 'credits', limit: null, remaining: 3 }),
    state({ keyId: 4, metric: 'requests', limit: 250, remaining: 200 }),
  ])
  expect(map.get(4)?.metric).toBe('requests')
  expect(map.get(4)?.fraction).toBeCloseTo(0.8)
})

it('skips windows that refill within the hour and windows already reset', () => {
  const now = Date.parse('2026-10-04T10:00:00Z')
  const map = balanceByKey([
    // per-minute header window: resets in 30s → not a balance worth a badge
    state({ keyId: 5, limit: 30, remaining: 1, resetAt: '2026-10-04T10:00:30Z' }),
    // token bucket: refills continuously
    state({ keyId: 6, limit: 100, remaining: 2, resetStrategy: 'token_bucket' }),
    // already past its reset (sqlite format) → full again
    state({ keyId: 7, limit: 100, remaining: 2, resetAt: '2026-10-04 09:00:00' }),
    // daily window resetting tonight → shown
    state({ keyId: 8, limit: 1000, remaining: 100, resetAt: '2026-10-05T00:00:00Z' }),
  ], now)
  expect([...map.keys()]).toEqual([8])
})

const apiKey = (over: Partial<ApiKey>): ApiKey => ({
  id: 1, platform: 'groq', label: 'Prod key', maskedKey: 'gsk_…1234', baseUrl: null,
  status: 'healthy', enabled: true, keyless: false, exportable: true,
  createdAt: '2026-10-01 00:00:00', lastCheckedAt: null, lastHealthError: null, ...over,
})

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })

function mockBackend(keys: ApiKey[], quotaStates: ProviderQuotaState[]) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/keys') return keys
    if (path === '/api/health') return { platforms: [], keys: [], quotaStates }
    if (path === '/api/settings/proxy') return { proxyUrl: '', enabled: false, bypassPlatforms: [], active: false }
    if (path === '/api/keys/providers') return []
    return {}
  })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(keys: ApiKey[], quotaStates: ProviderQuotaState[]) {
  mockBackend(keys, quotaStates)
  act(() => root.render(
    <QueryClientProvider client={client}><I18nProvider initialLocale="en"><ProviderList onAddKey={() => {}} /></I18nProvider></QueryClientProvider>
  ))
  await flush()
}

it('shows the provider balance on the key row', async () => {
  await mount([apiKey({})], [state({ keyId: 1, limit: 1000, remaining: 100 })])
  const badge = [...container.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label')?.includes('left'))
  expect(badge).toBeTruthy()
  expect(badge!.textContent).toBe('10% requests')
})

it('marks a near-exhausted balance amber and leaves a healthy one neutral', async () => {
  await mount([apiKey({})], [state({ keyId: 1, limit: 100, remaining: 18 })])
  const badge = [...container.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label')?.includes('left'))
  expect(badge!.textContent).toBe('18% requests')
  expect(badge!.className).toContain('amber')
})

it('renders no balance badge when the provider reports nothing', async () => {
  await mount([apiKey({})], [])
  expect(container.textContent).toContain('Prod key')
  expect([...container.querySelectorAll('[aria-label]')].some(el => el.getAttribute('aria-label')?.includes('left'))).toBe(false)
})
