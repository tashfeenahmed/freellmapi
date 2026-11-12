// @vitest-environment jsdom
// The Keys page shows at most one row dialog, held as one value (M30). A
// dialog opened for a key closes when that key is gone, so it can never pop
// back up on its own when a new key reuses the id or the endpoint.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ProviderList } from './provider-list'
import type { ApiKey } from '../../../../shared/types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const apiKey = (over: Partial<ApiKey>): ApiKey => ({
  id: 1, platform: 'groq', label: 'Prod key', maskedKey: 'gsk_…1234', baseUrl: null,
  status: 'healthy', enabled: true, keyless: false, exportable: true,
  createdAt: '2026-10-01 00:00:00', lastCheckedAt: null, lastHealthError: null, ...over,
})

let root: Root
let container: HTMLDivElement
let client: QueryClient
let keys: ApiKey[]

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/keys') return keys
    if (path === '/api/health') return { platforms: [], keys: [], quotaStates: [] }
    if (path === '/api/settings/proxy') return { proxyUrl: '', enabled: false, bypassPlatforms: [], active: false }
    return {}
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(initial: ApiKey[]) {
  keys = initial
  act(() => root.render(
    <QueryClientProvider client={client}><I18nProvider initialLocale="en"><ProviderList onAddKey={() => {}} /></I18nProvider></QueryClientProvider>
  ))
  await flush()
}
async function serveKeys(next: ApiKey[]) {
  keys = next
  await act(async () => { await client.invalidateQueries({ queryKey: ['keys'] }) })
  await flush()
}
async function click(label: string) {
  const button = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(button, `no button labelled ${label}`).not.toBeNull()
  await act(async () => { button!.click() })
  await flush()
}
const dialog = () => document.querySelector('[role="dialog"]')

it('opens the edit dialog from the row', async () => {
  await mount([apiKey({ id: 10 })])
  expect(dialog()).toBeNull()
  await click('Edit key')
  expect(dialog()).not.toBeNull()
})

it('does not reopen the edit dialog when a new key reuses a deleted key id', async () => {
  await mount([apiKey({ id: 10 })])
  await click('Edit key')
  expect(dialog()).not.toBeNull()

  await serveKeys([])
  // SQLite hands the freed id to the next key added.
  await serveKeys([apiKey({ id: 10, label: 'A different key' })])

  expect(dialog()).toBeNull()
})

it('does not reopen an endpoint dialog when the list empties and fills again', async () => {
  const endpoint = { platform: 'custom' as const, baseUrl: 'http://127.0.0.1:11434/v1', label: 'Local' }
  await mount([apiKey({ id: 20, ...endpoint })])
  await click('Add key')
  expect(dialog()).not.toBeNull()

  await serveKeys([])
  await serveKeys([apiKey({ id: 21, ...endpoint })])

  expect(dialog()).toBeNull()
})
