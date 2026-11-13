// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { CustomProviderSection } from './custom-provider-section'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

// #1457: "Fetch models" was an 11px muted text link that users missed.
let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en"><CustomProviderSection /></I18nProvider></QueryClientProvider>))
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function fetchModelsButton() {
  return [...container.querySelectorAll('button')].find(b => b.textContent === 'Fetch models')!
}

describe('custom provider "Fetch models" button (#1457)', () => {
  it('renders as a real button with an icon, not a muted text link', () => {
    const button = fetchModelsButton()
    expect(button.getAttribute('data-slot')).toBe('button')
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('stays disabled until the base URL is valid', () => {
    expect(fetchModelsButton().disabled).toBe(true)
    const input = container.querySelector<HTMLInputElement>('input[placeholder="http://127.0.0.1:11434/v1"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'http://127.0.0.1:11434/v1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(fetchModelsButton().disabled).toBe(false)
  })
})
