// @vitest-environment jsdom
// Draft-then-save on the Embeddings page (M33): the unsaved bar tracks a real
// difference from the server, and a save neither flashes the old order nor
// drops an edit made while it was in flight.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import EmbeddingsPage from './EmbeddingsPage'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

interface Provider { id: number; platform: string; modelId: string; displayName: string; priority: number; enabled: boolean; quotaLabel: string; keyCount: number }
const provider = (id: number, platform: string, priority: number): Provider => ({
  id, platform, modelId: `${platform}-embed`, displayName: platform, priority, enabled: true, quotaLabel: '', keyCount: 1,
})

let root: Root
let container: HTMLDivElement
let client: QueryClient
let server: { defaultFamily: string; families: { family: string; dimensions: number; maxInputTokens: null; isDefault: boolean; providers: Provider[] }[] }
let holdGet: Promise<void> | null
let holdPut: Promise<void> | null

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  server = {
    defaultFamily: 'fam',
    families: [{ family: 'fam', dimensions: 768, maxInputTokens: null, isDefault: true, providers: [provider(1, 'alpha', 1), provider(2, 'beta', 2)] }],
  }
  holdGet = null
  holdPut = null
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/embeddings' && init?.method === 'PUT') {
      if (holdPut) await holdPut
      const body = JSON.parse(String(init.body)) as { providers?: { id: number; priority: number; enabled: boolean }[] }
      for (const f of server.families) {
        f.providers = f.providers
          .map(p => ({ ...p, ...(body.providers?.find(b => b.id === p.id) ?? {}) }))
          .sort((a, b) => a.priority - b.priority)
      }
      return {}
    }
    if (path === '/api/embeddings') {
      if (holdGet) await holdGet
      return structuredClone(server)
    }
    if (path === '/api/embeddings/usage') return { families: [] }
    return {}
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount() {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><MemoryRouter><EmbeddingsPage /></MemoryRouter></I18nProvider>
    </QueryClientProvider>,
  ))
  await flush()
}
async function press(el: Element | undefined) {
  expect(el).toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
  await flush()
}
const order = () => [...container.querySelectorAll('section span.text-sm.font-medium')].map(s => s.textContent)
const byLabel = (label: string) => [...container.querySelectorAll(`[aria-label="${label}"]`)]
const saveButton = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Save changes')
const switches = () => [...container.querySelectorAll('[role="switch"]')]
const barShown = () => container.querySelector('.slide-in-from-bottom-4') !== null
function hold() {
  let release!: () => void
  const promise = new Promise<void>(r => { release = r })
  return { promise, release }
}

it('shows the unsaved bar after a reorder', async () => {
  await mount()
  expect(order()).toEqual(['alpha', 'beta'])
  await press(byLabel('Move down')[0])
  expect(order()).toEqual(['beta', 'alpha'])
  expect(barShown()).toBe(true)
})

it('hides the bar when the edit is undone', async () => {
  await mount()
  await press(byLabel('Move down')[0])
  await press(byLabel('Move up')[1])
  expect(order()).toEqual(['alpha', 'beta'])
  expect(barShown()).toBe(false)
})

it('keeps the saved order on screen until the refetch lands', async () => {
  await mount()
  await press(byLabel('Move down')[0])
  const get = hold()
  holdGet = get.promise
  await press(saveButton())

  expect(order()).toEqual(['beta', 'alpha'])

  get.release()
  await flush()
  expect(order()).toEqual(['beta', 'alpha'])
  expect(barShown()).toBe(false)
})

it('keeps an edit made while the save is in flight', async () => {
  await mount()
  await press(byLabel('Move down')[0])
  const put = hold()
  holdPut = put.promise
  await press(saveButton())

  // alpha is second now; switch it off while the PUT is still out.
  await press(switches()[1])
  put.release()
  await flush()

  expect(order()).toEqual(['beta', 'alpha'])
  expect(switches()[1].getAttribute('aria-checked')).toBe('false')
  expect(barShown()).toBe(true)
})
