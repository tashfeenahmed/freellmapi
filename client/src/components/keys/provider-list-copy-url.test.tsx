// @vitest-environment jsdom
// #2020: quick copy of the API request URL right next to "Copy full key" on
// each provider key row, without changing "Copy full key" behavior.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { ProviderList } from './provider-list'
import type { ApiKey } from '../../../../shared/types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const apiKey = (over: Partial<ApiKey>): ApiKey => ({
  id: 1, platform: 'groq', label: 'Prod key', maskedKey: 'gsk_…1234',
  baseUrl: null, apiUrl: 'https://api.groq.com/openai/v1',
  status: 'healthy', enabled: true, keyless: false, exportable: true,
  createdAt: '2026-10-01 00:00:00', lastCheckedAt: null, lastHealthError: null, ...over,
})

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.mocked(copyText).mockReset().mockResolvedValue(true)
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.error).mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  client.clear()
  container.remove()
})

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

async function mount(keys: ApiKey[]) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/keys') return keys
    if (path === '/api/health') return { platforms: [], keys: [], quotaStates: [] }
    if (path === '/api/settings/proxy') return { proxyUrl: '', enabled: false, bypassPlatforms: [], active: false }
    return {}
  })
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <ProviderList onAddKey={() => {}} />
      </I18nProvider>
    </QueryClientProvider>,
  ))
  await flush()
}

it('renders the copy-URL button immediately next to Copy full key and copies the provider API URL', async () => {
  await mount([apiKey({ id: 1, platform: 'groq', apiUrl: 'https://api.groq.com/openai/v1' })])

  const copyKeyBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Copy full key"]')
  const copyUrlBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Copy base URL"]')
  expect(copyKeyBtn).not.toBeNull()
  expect(copyUrlBtn).not.toBeNull()

  // Positioned right next to Copy full key in the row's action cluster.
  const actionButtons = [...copyKeyBtn!.closest('div')!.querySelectorAll('button')]
  expect(actionButtons.indexOf(copyUrlBtn!)).toBe(actionButtons.indexOf(copyKeyBtn!) + 1)

  await act(async () => {
    copyUrlBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()

  expect(copyText).toHaveBeenCalledTimes(1)
  expect(copyText).toHaveBeenCalledWith('https://api.groq.com/openai/v1')
  expect(toast.success).toHaveBeenCalledWith('Base URL copied to clipboard')
  expect(copyUrlBtn!.getAttribute('aria-label')).toBe('Base URL copied to clipboard')
})

it('copies the configured host and port URL for custom endpoints', async () => {
  await mount([
    apiKey({
      id: 2,
      platform: 'custom',
      label: 'Local vLLM',
      maskedKey: 'sk-l…9999',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiUrl: 'http://127.0.0.1:8080/v1',
    }),
  ])

  const copyUrlBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Copy base URL"]')
  expect(copyUrlBtn).not.toBeNull()

  await act(async () => {
    copyUrlBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()

  expect(copyText).toHaveBeenCalledWith('http://127.0.0.1:8080/v1')
  expect(toast.success).toHaveBeenCalledWith('Base URL copied to clipboard')
})

it('reports a copy failure without switching into the copied state', async () => {
  vi.mocked(copyText).mockResolvedValue(false)
  await mount([apiKey({ id: 3, apiUrl: 'https://openrouter.ai/api/v1', platform: 'openrouter' })])

  const copyUrlBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Copy base URL"]')!
  await act(async () => {
    copyUrlBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()

  expect(copyText).toHaveBeenCalledWith('https://openrouter.ai/api/v1')
  expect(toast.error).toHaveBeenCalledWith("Couldn't copy — select the text and copy it manually")
  expect(toast.success).not.toHaveBeenCalled()
  expect(copyUrlBtn.getAttribute('aria-label')).toBe('Copy base URL')
})

it('keeps Copy full key opening the reveal dialog unchanged', async () => {
  await mount([apiKey({ id: 4, maskedKey: 'gsk_…5678', apiUrl: 'https://api.groq.com/openai/v1' })])

  const copyKeyBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Copy full key"]')!
  await act(async () => {
    copyKeyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()

  // Copy full key opens the password-gated dialog rather than copying the URL.
  expect(copyText).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Copy full key')
  expect(document.body.textContent).toContain('gsk_…5678')
})

it('omits the copy-URL button when neither apiUrl nor baseUrl is available', async () => {
  await mount([apiKey({ id: 5, platform: 'cloudflare', baseUrl: null, apiUrl: null })])

  expect(container.querySelector('button[aria-label="Copy full key"]')).not.toBeNull()
  expect(container.querySelector('button[aria-label="Copy base URL"]')).toBeNull()
})
