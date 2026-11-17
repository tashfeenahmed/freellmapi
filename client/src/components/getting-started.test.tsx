// @vitest-environment jsdom
// #1870: a new install starts with its no-key providers on. Step 1 then says
// so instead of showing "Add a provider key" crossed out, and keeps "Add keys".
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { GettingStarted } from './getting-started'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function mount(keys: { keyless: boolean }[]) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/keys') return keys
    if (path.startsWith('/api/analytics/summary')) return { totalRequests: 0 }
    if (path === '/api/settings/api-key') return { apiKey: 'freellmapi-test' }
    return {}
  })
  act(() => root.render(
    <QueryClientProvider client={client}><MemoryRouter><I18nProvider initialLocale="en"><GettingStarted /></I18nProvider></MemoryRouter></QueryClientProvider>,
  ))
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}
const step1 = () => container.querySelector('li')!

it('says the no-key providers are on and keeps Add keys when those are the only keys', async () => {
  await mount([{ keyless: true }, { keyless: true }])
  expect(step1().textContent).toContain('No-key providers are on')
  expect(step1().textContent).toContain('Add your own keys')
  expect(step1().querySelector('.line-through')).toBeNull()
  expect(step1().textContent).toContain('Add keys')
  expect(container.textContent).toContain('1 of 3')
})

it('crosses step 1 off as before once a real key is added', async () => {
  await mount([{ keyless: true }, { keyless: false }])
  expect(step1().querySelector('.line-through')?.textContent).toBe('Add a provider key')
  expect(step1().textContent).not.toContain('Add keys')
})

it('asks for a key when there is none', async () => {
  await mount([])
  expect(step1().textContent).toContain('Add a provider key')
  expect(step1().textContent).toContain('Connect at least one provider account')
})
