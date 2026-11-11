// @vitest-environment jsdom
// Custom search relays and decision endpoints (#1777) are added from the same
// Custom provider form as chat/embedding/media endpoints, and say which wire
// contract the endpoint has to speak.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import en from '@/i18n/locales/en.json'
import { CUSTOM_MODEL_KIND_LABEL } from './shared'
import { CustomProviderSection } from './custom-provider-section'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
// A native <select> stands in for the Base UI listbox so the test can pick a type.
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select data-testid="custom-type" value={value} onChange={e => onValueChange(e.target.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}))

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockResolvedValue({})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en"><CustomProviderSection /></I18nProvider></QueryClientProvider>))
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function addEndpoint(type: string, model: string, apiKey?: string) {
  setValue(container.querySelector<HTMLSelectElement>('[data-testid="custom-type"]')!, type)
  setValue(container.querySelector<HTMLInputElement>('input[placeholder="http://127.0.0.1:11434/v1"]')!, 'http://127.0.0.1:9000/v1')
  setValue(container.querySelector('textarea')!, model)
  if (apiKey) setValue(container.querySelector<HTMLInputElement>('input[type="password"]')!, apiKey)
  await act(async () => { container.querySelector('form')!.requestSubmit() })
}

describe('custom search and decision endpoints (#1777)', () => {
  it.each([
    ['search', 'my-search', 'Add search engine', /POST <base URL>\/search in Tavily's request format/],
    ['decision', 'my-decider', 'Add decision model', /POST <base URL>\/decide/],
  ])('registers a custom %s endpoint through /api/media/custom', async (type, model, buttonLabel, hint) => {
    setValue(container.querySelector<HTMLSelectElement>('[data-testid="custom-type"]')!, type)
    expect(container.querySelector('[data-testid="custom-contract-hint"]')?.textContent).toMatch(hint)
    expect(container.querySelector('button[type="submit"]')!.textContent).toBe(buttonLabel)
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.placeholder).toBe(model)

    await addEndpoint(type, model, 'local-secret')
    const post = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/media/custom')
    expect(post).toBeDefined()
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      baseUrl: 'http://127.0.0.1:9000/v1', model, apiKey: 'local-secret', modality: type,
    })
  })

  it('shows no contract hint for OpenAI-compatible types', () => {
    expect(container.querySelector('[data-testid="custom-contract-hint"]')).toBeNull()
    setValue(container.querySelector<HTMLSelectElement>('[data-testid="custom-type"]')!, 'image')
    expect(container.querySelector('[data-testid="custom-contract-hint"]')).toBeNull()
  })

  it('labels every custom model kind the Keys page can list', () => {
    const keys = en.keys as unknown as Record<string, unknown>
    for (const kind of ['chat', 'embedding', 'image', 'audio', 'transcription', 'search', 'decision'] as const) {
      const key = CUSTOM_MODEL_KIND_LABEL[kind]
      expect(key, kind).toBeTruthy()
      expect(keys[key.replace(/^keys\./, '')], kind).toBeTruthy()
    }
  })
})
