// @vitest-environment jsdom
// #1174: Models → Search lists the catalog's search engines in failover order,
// marks the first enabled one as default, badges Premium-first rows with the
// day they reach Free, and promotes an engine with PATCH priority 0.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { SearchEngine } from '@/lib/search'
import { SearchEnginesView } from './search-engines'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const engine = (over: Partial<SearchEngine>): SearchEngine => ({
  id: 1, platform: 'tavily', engineId: 'tavily-search', displayName: 'Tavily', priority: 0,
  enabled: true, quotaLabel: '1,000 credits/month', creditsPerQuery: 1, features: null,
  premiumSince: null, keyCount: 1, healthyKeyCount: 1, searchesThisMonth: 0, ...over,
})

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(engines: SearchEngine[]) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/search/engines') return engines
    if (path.startsWith('/api/analytics/search')) return { total: 0, today: 3, successRate: 100, avgLatencyMs: 0, byEngine: [], series: [] }
    return {}
  })
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MemoryRouter><SearchEnginesView /></MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  ))
  await flush()
}

it('lists engines in priority order and marks the first enabled one as default', async () => {
  await mount([
    engine({ id: 2, platform: 'exa', engineId: 'exa-search', displayName: 'Exa', priority: 1, searchesThisMonth: 12 }),
    engine({ id: 1, searchesThisMonth: 40 }),
  ])
  const names = [...container.querySelectorAll('section span.font-mono')]
    .map(s => s.textContent)
    .filter(text => text?.endsWith('-search'))
  expect(names).toEqual(['tavily-search', 'exa-search'])
  expect(container.textContent).toContain('Default')
  // The month card sums the engine rows; today comes from the analytics call.
  expect(container.textContent).toContain('52 req this month')
  expect(container.textContent).toContain('3 req today')
})

it('badges a Premium-first engine with the day it reaches Free', async () => {
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  await mount([engine({ id: 3, platform: 'firecrawl', engineId: 'firecrawl-search', displayName: 'Firecrawl', premiumSince: since })])
  expect(container.textContent).toMatch(/Premium · free from/)
})

it('promotes an engine to default with priority 0', async () => {
  await mount([engine({ id: 1 }), engine({ id: 2, platform: 'exa', engineId: 'exa-search', displayName: 'Exa', priority: 1 })])
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Make default')!
  act(() => { button.click() })
  await flush()
  const patch = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PATCH')
  expect(patch?.[0]).toBe('/api/search/engines/2')
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ priority: 0 })
})

it('tests the selected engine through the search test endpoint', async () => {
  await mount([engine({ id: 7 })])
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Test')!
  expect(button).toBeTruthy()
  act(() => button.click())
  await flush()
  const request = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/search/engines/7/test')
  expect(request?.[1]?.method).toBe('POST')
  expect(JSON.parse(String(request?.[1]?.body)).query).toBeTruthy()
})

it('shows the empty state before the catalog carries any engine', async () => {
  await mount([])
  expect(container.textContent).toContain('No search engines yet')
})
