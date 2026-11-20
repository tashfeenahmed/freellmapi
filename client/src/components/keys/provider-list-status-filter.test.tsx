// @vitest-environment jsdom
// #1907: the Keys status filter used to keep or drop a whole provider group.
// A Custom group with one failing key then listed every key in that group,
// healthy ones included, and the header still read "x healthy y issues".
// Each filter should narrow group.keys the way search already does.
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

// Custom holds one green and one red key. Groq mixes a green key, a red key,
// and a disabled green key, so "healthy" cannot mean "the group has no issues".
const keys: ApiKey[] = [
  apiKey({ id: 1, platform: 'custom', label: 'Green custom', maskedKey: 'cust…ok', baseUrl: 'https://green.example/v1' }),
  apiKey({ id: 2, platform: 'custom', label: 'Red custom', maskedKey: 'cust…bad', baseUrl: 'https://red.example/v1', status: 'error' }),
  apiKey({ id: 3, platform: 'groq', label: 'Green groq', maskedKey: 'gsk_…ok' }),
  apiKey({ id: 4, platform: 'groq', label: 'Red groq', maskedKey: 'gsk_…bad', status: 'invalid' }),
  apiKey({ id: 5, platform: 'groq', label: 'Off groq', maskedKey: 'gsk_…off', enabled: false }),
]

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount() {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/keys') return keys
    if (path === '/api/health') return { platforms: [], keys: [], quotaStates: [] }
    if (path === '/api/settings/proxy') return { proxyUrl: '', enabled: false, bypassPlatforms: [], active: false }
    return {}
  })
  act(() => root.render(
    <QueryClientProvider client={client}><I18nProvider initialLocale="en"><ProviderList onAddKey={() => {}} /></I18nProvider></QueryClientProvider>
  ))
  await flush()
}

async function selectFilter(label: string) {
  const tab = [...container.querySelectorAll('[role="tab"]')].find(el => el.textContent === label)
  if (!tab) throw new Error(`missing filter ${label}`)
  await act(async () => { (tab as HTMLButtonElement).click() })
  await flush()
}

const providers = () => [...container.querySelectorAll('h3')].map(h => h.textContent)
function shownCount(label: string): string {
  const h3 = [...container.querySelectorAll('h3')].find(h => h.textContent === label)
  if (!h3?.parentElement) throw new Error(`missing group ${label}`)
  return h3.parentElement.querySelector('.tabular-nums')?.textContent ?? ''
}
const header = (label: string) => {
  const h3 = [...container.querySelectorAll('h3')].find(h => h.textContent === label)
  if (!h3?.parentElement) throw new Error(`missing group ${label}`)
  return h3.parentElement.textContent ?? ''
}

it('lists every key while the status filter is all', async () => {
  await mount()
  expect(container.textContent).toContain('cust…ok')
  expect(container.textContent).toContain('cust…bad')
  expect(container.textContent).toContain('gsk_…ok')
  expect(container.textContent).toContain('gsk_…bad')
  expect(container.textContent).toContain('gsk_…off')
  expect(shownCount('Custom (OpenAI-compatible)')).toBe('2')
  expect(header('Custom (OpenAI-compatible)')).toContain('1 healthy')
  expect(header('Custom (OpenAI-compatible)')).toContain('1 issue')
  expect(shownCount('Groq')).toBe('3')
})

it('lists only keys with issues under the issues filter', async () => {
  await mount()
  await selectFilter('Issues')
  expect(container.textContent).toContain('cust…bad')
  expect(container.textContent).toContain('gsk_…bad')
  expect(container.textContent).not.toContain('cust…ok')
  expect(container.textContent).not.toContain('gsk_…ok')
  expect(container.textContent).not.toContain('gsk_…off')
  expect(providers()).toEqual(['Groq', 'Custom (OpenAI-compatible)'])
  expect(shownCount('Custom (OpenAI-compatible)')).toBe('1')
  expect(header('Custom (OpenAI-compatible)')).toContain('1 issue')
  expect(header('Custom (OpenAI-compatible)')).not.toContain('healthy')
  expect(shownCount('Groq')).toBe('1')
  expect(header('Groq')).not.toContain('healthy')
})

it('lists only healthy enabled keys under the healthy filter', async () => {
  await mount()
  await selectFilter('Healthy')
  expect(container.textContent).toContain('cust…ok')
  expect(container.textContent).toContain('gsk_…ok')
  expect(container.textContent).not.toContain('cust…bad')
  expect(container.textContent).not.toContain('gsk_…bad')
  expect(container.textContent).not.toContain('gsk_…off')
  expect(shownCount('Custom (OpenAI-compatible)')).toBe('1')
  expect(header('Custom (OpenAI-compatible)')).toContain('1 healthy')
  expect(header('Custom (OpenAI-compatible)')).not.toContain('issue')
  expect(shownCount('Groq')).toBe('1')
  expect(header('Groq')).not.toContain('issue')
})

it('lists only disabled keys under the disabled filter', async () => {
  await mount()
  await selectFilter('Disabled')
  expect(container.textContent).toContain('gsk_…off')
  expect(container.textContent).not.toContain('cust…ok')
  expect(container.textContent).not.toContain('cust…bad')
  expect(container.textContent).not.toContain('gsk_…ok')
  expect(container.textContent).not.toContain('gsk_…bad')
  expect(providers()).toEqual(['Groq'])
  expect(shownCount('Groq')).toBe('1')
})
