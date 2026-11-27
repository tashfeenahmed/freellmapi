// @vitest-environment jsdom
// #2030: three-dot provider menu exposes "Add another API key" preselected to
// that provider (or opens AddEndpointKeyDialog for a single-endpoint custom
// group), and deleting a key invalidates the fallback/token-usage cache.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ProviderList } from './provider-list'
import type { ApiKey, Platform } from '../../../../shared/types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const apiKey = (over: Partial<ApiKey>): ApiKey => ({
  id: 1, platform: 'groq', label: 'Primary key', maskedKey: 'gsk_…1111', baseUrl: null,
  status: 'healthy', enabled: true, keyless: false, exportable: true,
  createdAt: '2026-10-01 00:00:00', lastCheckedAt: null, lastHealthError: null, ...over,
})

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})

async function flush() {
  for (let i = 0; i < 2; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

async function mount(keys: ApiKey[], onAddKey: (platform?: Platform) => void = () => {}) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/keys') return keys
    if (path === '/api/health') return { platforms: [], keys: [], quotaStates: [] }
    if (path === '/api/settings/proxy') return { proxyUrl: '', enabled: false, bypassPlatforms: [], active: false }
    return {}
  })
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <ProviderList onAddKey={onAddKey} />
      </I18nProvider>
    </QueryClientProvider>,
  ))
  await flush()
}

describe('ProviderList three-dot menu: Add another API key (#2030)', () => {
  it('offers "Add another API key" for a built-in provider and passes its platform to onAddKey', async () => {
    const onAddKey = vi.fn()
    await mount([apiKey({ id: 1, platform: 'groq' })], onAddKey)

    const trigger = container.querySelector('button[aria-label="Provider actions"]') as HTMLButtonElement | null
    expect(trigger).not.toBeNull()
    await act(async () => { trigger!.click() })
    await flush()

    const menuItems = [...document.querySelectorAll('[role="menuitem"]')]
    const addAnotherItem = menuItems.find(el => el.textContent?.includes('Add another API key')) as HTMLElement | undefined
    expect(addAnotherItem).toBeDefined()

    await act(async () => { addAnotherItem!.click() })
    await flush()

    expect(onAddKey).toHaveBeenCalledWith('groq')
  }, 15_000)

  it('opens AddEndpointKeyDialog from the three-dot menu for a single-endpoint custom group', async () => {
    const onAddKey = vi.fn()
    await mount([
      apiKey({ id: 10, platform: 'custom', label: 'My Relay', maskedKey: 'sk_…9999', baseUrl: 'https://relay.example/v1' }),
    ], onAddKey)

    const trigger = container.querySelector('button[aria-label="Provider actions"]') as HTMLButtonElement | null
    expect(trigger).not.toBeNull()
    await act(async () => { trigger!.click() })
    await flush()

    const menuItems = [...document.querySelectorAll('[role="menuitem"]')]
    const addAnotherItem = menuItems.find(el => el.textContent?.includes('Add another API key')) as HTMLElement | undefined
    expect(addAnotherItem).toBeDefined()

    await act(async () => { addAnotherItem!.click() })
    await flush()

    expect(onAddKey).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('https://relay.example/v1')
    expect(document.querySelector('#endpoint-key')).not.toBeNull()
  }, 15_000)
})
