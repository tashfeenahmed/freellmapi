// @vitest-environment jsdom
// `/keys?add=<platform>` opens Add key preselected to that provider (#1354:
// the Decision routing setup guide links here), then drops the param.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import KeysPage from './KeysPage'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(async () => []) }))
// Only the page's own add-key wiring is under test; the sections are stubbed.
vi.mock('@/components/keys/add-key-dialog', () => ({
  AddKeyDialog: ({ open, initialPlatform }: { open: boolean; initialPlatform?: string }) =>
    <div data-testid="add-dialog">{open ? `open:${initialPlatform ?? ''}` : 'closed'}</div>,
}))
vi.mock('@/components/keys/quota-signals-section', () => ({ QuotaSignalsSection: () => null }))
vi.mock('@/components/keys/unified-key-section', () => ({ UnifiedKeySection: () => null }))
vi.mock('@/components/keys/client-profiles-section', () => ({ ClientProfilesSection: () => null }))
vi.mock('@/components/keys/proxy-settings-section', () => ({ ProxySettingsSection: () => null }))
vi.mock('@/components/keys/backups-section', () => ({ BackupsSection: () => null }))
vi.mock('@/components/keys/anthropic-section', () => ({ AnthropicSection: () => null }))
vi.mock('@/components/keys/provider-list', () => ({ ProviderList: () => null }))
vi.mock('@/components/keys/provider-checklist-section', () => ({ ProviderChecklistSection: () => null }))
vi.mock('@/components/keys/export-keys-dialog', () => ({ ExportKeysDialog: () => null }))
vi.mock('@/components/keys/agent-compatibility-section', () => ({ AgentCompatibilitySection: () => null }))

let root: Root
let container: HTMLDivElement
beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

function Search() { return <div data-testid="search">{useLocation().search}</div> }

async function mount(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[url]}>
          <Routes><Route path="/keys" element={<><KeysPage /><Search /></>} /></Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  ))
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

const dialog = () => container.querySelector('[data-testid="add-dialog"]')?.textContent
const search = () => container.querySelector('[data-testid="search"]')?.textContent

it('opens Add key preselected from ?add= and clears the param', async () => {
  await mount('/keys?add=cloudflare')
  expect(dialog()).toBe('open:cloudflare')
  expect(search()).toBe('')
})

it('ignores an unknown or removed provider', async () => {
  await mount('/keys?add=not-a-provider')
  expect(dialog()).toBe('closed')
  await mount('/keys?add=auray')
  expect(dialog()).toBe('closed')
})

it('stays closed without the param', async () => {
  await mount('/keys')
  expect(dialog()).toBe('closed')
})
