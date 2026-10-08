// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { ApiKey } from '../../../../shared/types'
import { EditKeyDialog } from './edit-key-dialog'
import { EditModelsDialog } from './edit-models-dialog'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
// Keep the real form and state; remove only portal/focus management.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))
let root: Root
let container: HTMLDivElement
const key = { id: 7, platform: 'cloudflare', label: 'Work', maskedKey: '***', modelScope: null } as ApiKey
const onOpenChange = vi.fn()

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockResolvedValue({ success: true })
  onOpenChange.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
function mount(component: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  act(() => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">{component}</I18nProvider></QueryClientProvider>))
}
function enter(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function submit() {
  act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
}
describe('editing provider credentials', () => {
  it('sends both trimmed Cloudflare credential parts in the PATCH request', async () => {
    mount(<EditKeyDialog apiKey={key} onOpenChange={onOpenChange} />)
    enter('input[placeholder="Account ID"]', ' account-123 ')
    enter('#edit-key-value', ' token-456 ')
    await submit()
    expect(apiFetch).toHaveBeenCalledWith('/api/keys/7', { method: 'PATCH', body: JSON.stringify({ key: 'account-123:token-456' }) })
  })
  it.each(['account', 'token'])('does not submit an incomplete Cloudflare credential: %s only', async part => {
    mount(<EditKeyDialog apiKey={key} onOpenChange={onOpenChange} />)
    enter(part === 'account' ? 'input[placeholder="Account ID"]' : '#edit-key-value', 'incomplete')
    await submit()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
  it('can change a label without replacing its saved credential', async () => {
    mount(<EditKeyDialog apiKey={key} onOpenChange={onOpenChange} />)
    enter('#edit-key-label', 'Renamed')
    await submit()
    expect(apiFetch).toHaveBeenCalledWith('/api/keys/7', { method: 'PATCH', body: JSON.stringify({ label: 'Renamed' }) })
  })
  it('lets the anonymous row of a key-optional provider take a real key (#1331)', async () => {
    mount(<EditKeyDialog apiKey={{ ...key, platform: 'kilo', keyless: true, keyOptional: true }} onOpenChange={onOpenChange} />)
    const input = container.querySelector<HTMLInputElement>('#edit-key-value')!
    expect(input.readOnly).toBe(false)
    expect(input.placeholder).toBe('Optional')
    enter('#edit-key-value', ' kilo-token ')
    await submit()
    expect(apiFetch).toHaveBeenCalledWith('/api/keys/7', { method: 'PATCH', body: JSON.stringify({ key: 'kilo-token' }) })
  })
  it('sends a normal provider token without an account prefix', async () => {
    mount(<EditKeyDialog apiKey={{ ...key, platform: 'groq' }} onOpenChange={onOpenChange} />)
    enter('#edit-key-value', ' new-token ')
    await submit()
    expect(apiFetch).toHaveBeenCalledWith('/api/keys/7', { method: 'PATCH', body: JSON.stringify({ key: 'new-token' }) })
  })
  it('sends a monthly request cap typed into the budget field', async () => {
    mount(<EditKeyDialog apiKey={{ ...key, platform: 'groq', monthlyRequestCap: 0, monthlyTokenCap: 0 }} onOpenChange={onOpenChange} />)
    enter('#edit-key-request-cap', '1000')
    await submit()
    expect(apiFetch).toHaveBeenCalledWith('/api/keys/7', { method: 'PATCH', body: JSON.stringify({ monthlyRequestCap: 1000 }) })
  })
  it('clearing a cap field submits 0 (unlimited)', async () => {
    mount(<EditKeyDialog apiKey={{ ...key, platform: 'groq', monthlyTokenCap: 500000 }} onOpenChange={onOpenChange} />)
    enter('#edit-key-token-cap', '')
    await submit()
    expect(apiFetch).toHaveBeenCalledWith('/api/keys/7', { method: 'PATCH', body: JSON.stringify({ monthlyTokenCap: 0 }) })
  })
  it('shows the current month usage without touching the form', async () => {
    mount(<EditKeyDialog
      apiKey={{ ...key, platform: 'groq', monthlyUsage: { requests: 42, tokens: 1234, resetsAt: '2026-10-01T00:00:00.000Z' } }}
      onOpenChange={onOpenChange}
    />)
    expect(container.textContent).toContain('42 requests')
    expect(container.textContent).toContain(`${(1234).toLocaleString()} tokens`)
    await submit()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
  it('keeps the budget collapsed when no cap is set', async () => {
    mount(<EditKeyDialog apiKey={{ ...key, platform: 'groq', monthlyRequestCap: 0, monthlyTokenCap: 0 }} onOpenChange={onOpenChange} />)
    expect(document.querySelector('details')!.open).toBe(false)
  })
  it('opens the budget when a cap is already set', async () => {
    mount(<EditKeyDialog apiKey={{ ...key, platform: 'groq', monthlyRequestCap: 50 }} onOpenChange={onOpenChange} />)
    expect(document.querySelector('details')!.open).toBe(true)
  })
  it('does not submit a non-numeric cap', async () => {
    mount(<EditKeyDialog apiKey={{ ...key, platform: 'groq' }} onOpenChange={onOpenChange} />)
    enter('#edit-key-request-cap', '10k')
    await submit()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(container.querySelector('#edit-key-request-cap')!.getAttribute('aria-invalid')).toBe('true')
  })
  it('loads model choices from the full catalog instead of a limited active chain', async () => {
    vi.mocked(apiFetch).mockImplementation(async path => path === '/api/models'
      ? [{ platform: 'cloudflare', modelId: 'outside-chain', displayName: 'Outside active chain', sizeLabel: 'Small', contextWindow: 1000 }]
      : [])
    mount(<EditModelsDialog apiKey={key} onOpenChange={onOpenChange} />)
    await flush()
    expect(container.textContent).toContain('Outside active chain')
    expect(apiFetch).toHaveBeenCalledWith('/api/models')
    expect(apiFetch).not.toHaveBeenCalledWith('/api/fallback')
  })
})
