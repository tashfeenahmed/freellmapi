// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { useSearchReadiness } from '@/hooks/use-search-readiness'
import { invalidateSearchQueries, type SearchEngine, type SearchReadiness } from '@/lib/search'
import { AddKeyForm } from './add-key-form'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
let root: Root, container: HTMLDivElement, client: QueryClient
let added: boolean, failed: boolean, cooling: boolean, invalid: boolean
const engine = (): SearchEngine => ({ id: 1, platform: 'parallel', engineId: 'parallel-search', displayName: 'Parallel', priority: 0, enabled: true,
  quotaLabel: '', creditsPerQuery: null, features: null, premiumSince: null, keyCount: added ? 1 : 0, healthyKeyCount: added && !invalid ? 1 : 0, searchesThisMonth: 0 })
const status = (): SearchReadiness => ({ status: added && !invalid ? cooling ? 'cooling_down' : 'ready' : 'needs_configuration',
  engines: [{ engine: 'parallel-search', platform: 'parallel', state: added ? invalid ? 'key_error' : cooling ? 'cooling_down' : 'ready' : 'needs_key' }],
  missing_from_catalog: [], catalog: { appliedVersion: 'test', appliedTier: 'monthly', lastSyncMs: 1, lastError: null } })
function Probe() {
  const state = useSearchReadiness()
  return <button data-search disabled={!state.available}>{state.failed ? 'error' : state.available ? 'ready' : 'unavailable'}</button>
}
beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  added = failed = cooling = invalid = false
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false }, mutations: { retry: false } } })
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path, init) => {
    if (path === '/api/keys' && init?.method === 'POST') { added = true; return { id: 1, platform: 'parallel' } }
    if (path === '/api/search/engines') { if (failed) throw new Error('HTTP 502'); return [engine()] }
    if (path === '/api/search/status') return status()
    return []
  })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); focusManager.setFocused(undefined); vi.useRealTimers() })
async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function mount(probe = false) {
  act(() => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">
    <AddKeyForm initialPlatform="parallel" onSuccess={() => {}} />{probe && <Probe />}
  </I18nProvider></QueryClientProvider>))
  await flush()
}
async function add() {
  act(() => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await flush()
}

it('invalidates fresh inactive engine AND status caches after key creation (#1810)', async () => {
  client.setQueryData(['search-engines'], [engine()]); client.setQueryData(['search-status'], status())
  await mount(); await add()
  expect(added).toBe(true)
  expect(client.getQueryState(['search-status'])?.isInvalidated).toBe(true)
  const engines = await client.fetchQuery<SearchEngine[]>({ queryKey: ['search-engines'], queryFn: () => apiFetch('/api/search/engines') })
  expect(engines[0].healthyKeyCount).toBe(1)
})

it('enables an active Playground readiness query immediately after key creation', async () => {
  await mount(true)
  expect(container.querySelector<HTMLButtonElement>('[data-search]')!.disabled).toBe(true)
  await add()
  expect(container.querySelector<HTMLButtonElement>('[data-search]')!.disabled).toBe(false)
})

it('refreshes readiness after key disable/delete without a page reload', async () => {
  added = true; await mount(true)
  expect(container.querySelector<HTMLButtonElement>('[data-search]')!.disabled).toBe(false)
  added = false; act(() => invalidateSearchQueries(client)); await flush()
  expect(container.querySelector<HTMLButtonElement>('[data-search]')!.disabled).toBe(true)
})

it('does not enable search for invalid keys or provider cooldowns', async () => {
  added = invalid = true; await mount(true)
  expect(container.querySelector<HTMLButtonElement>('[data-search]')!.disabled).toBe(true)
  invalid = false; cooling = true; act(() => invalidateSearchQueries(client)); await flush()
  expect(container.querySelector<HTMLButtonElement>('[data-search]')!.disabled).toBe(true)
  cooling = false; act(() => invalidateSearchQueries(client)); await flush()
  expect(container.querySelector<HTMLButtonElement>('[data-search]')!.disabled).toBe(false)
})

it('does not treat stale successful data as ready after an API error', async () => {
  added = true; await mount(true); failed = true
  act(() => invalidateSearchQueries(client)); await flush()
  expect(container.querySelector<HTMLButtonElement>('[data-search]')!.disabled).toBe(true)
  expect(container.querySelector('[data-search]')!.textContent).toBe('error')
})

it('polls local readiness to pick up background catalog/key changes', async () => {
  vi.useFakeTimers(); focusManager.setFocused(true)
  act(() => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>))
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  added = true
  await act(async () => { await vi.advanceTimersByTimeAsync(30_100) })
  expect(container.querySelector<HTMLButtonElement>('[data-search]')!.disabled).toBe(false)
})
