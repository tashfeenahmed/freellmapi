// @vitest-environment jsdom
// #1870: the Keys page line for existing installs: "No-key providers
// available (N) · Enable all · ×". Hidden when the server lists none.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { KeylessNotice } from './keyless-notice'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let client: QueryClient
let available: { platform: string; name: string }[]

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  available = [{ platform: 'kilo', name: 'Kilo Gateway' }, { platform: 'ovh', name: 'OVH AI Endpoints' }, { platform: 'parallel', name: 'Parallel' }]
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/keys/keyless-available') return { providers: available }
    if (path === '/api/keys/keyless-available/enable') { const enabled = available.map(p => p.platform); available = []; return { enabled } }
    if (path === '/api/keys/keyless-available/dismiss') { available = []; return { ok: true } }
    return {}
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount() {
  act(() => root.render(
    <QueryClientProvider client={client}><I18nProvider initialLocale="en"><KeylessNotice /></I18nProvider></QueryClientProvider>,
  ))
  await flush()
}
const notice = () => container.querySelector('[data-testid="keyless-notice"]')
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement

it('shows the count and names the providers on hover', async () => {
  await mount()
  expect(notice()?.textContent).toContain('No-key providers available (3)')
  expect(notice()?.querySelector('span')?.getAttribute('title')).toBe('Kilo Gateway, OVH AI Endpoints, Parallel')
})

it('renders nothing when the catalog offers no new no-key providers', async () => {
  available = []
  await mount()
  expect(notice()).toBeNull()
  expect(container.textContent).toBe('')
})

it('Enable all calls the server and the line goes away', async () => {
  await mount()
  await act(async () => { button('Enable all').click() })
  await flush()
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/keys/keyless-available/enable', { method: 'POST' })
  expect(notice()).toBeNull()
})

it('dismiss hides the line without enabling anything', async () => {
  await mount()
  await act(async () => { button('Dismiss').click() })
  await flush()
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/keys/keyless-available/dismiss', { method: 'POST' })
  expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith('/api/keys/keyless-available/enable', expect.anything())
  expect(notice()).toBeNull()
})
