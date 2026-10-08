// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ProviderChecklistSection } from './provider-checklist-section'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

// #1225: each unconfigured provider chip must carry a direct link to the
// provider's signup/key page, not only the add-key dialog.

const providers = [
  { platform: 'groq', name: 'Groq', configured: true, keyless: false },
  { platform: 'openrouter', name: 'OpenRouter', configured: false, keyless: false },
  { platform: 'ollama', name: 'Ollama', configured: false, keyless: true },
]
const payload = { providers, summary: { configured: 1, total: 3 } }

let root: Root
let container: HTMLDivElement
let client: QueryClient
const onAddKey = vi.fn()

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Some jsdom builds here expose no window.localStorage; I18nProvider reads
  // it during detectLocale. A tiny in-memory stand-in keeps the test about
  // the links, not the environment.
  if (typeof window !== 'undefined' && !window.localStorage) {
    const store = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    })
  }
  vi.mocked(apiFetch).mockReset().mockResolvedValue(payload as never)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  onAddKey.mockReset()
})

async function renderExpanded() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <ProviderChecklistSection onAddKey={onAddKey} />
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  // Wait (polling, so it is robust to how many microtask hops the query
  // client and React take per environment) for the checklist toggle to
  // render once the mocked fetch resolves, then expand it.
  await act(async () => {
    for (let i = 0; i < 50; i++) {
      if (container.querySelector('button')) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  })
  const toggle = container.querySelector('button')!
  await act(async () => {
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('provider checklist signup links (#1225)', () => {
  it('renders a signup link on unconfigured keyed chips pointing at the platform URL', async () => {
    await renderExpanded()
    const link = Array.from(container.querySelectorAll('a')).find(a =>
      (a.getAttribute('aria-label') ?? '').toLowerCase().includes('openrouter'),
    )
    expect(link).toBeDefined()
    expect(link!.getAttribute('href')).toBe('https://openrouter.ai/keys')
    expect(link!.getAttribute('rel')).toContain('noopener')
  })

  it('omits the signup link on keyless chips (nothing to sign up for)', async () => {
    await renderExpanded()
    expect(
      Array.from(container.querySelectorAll('a')).some(a =>
        (a.getAttribute('aria-label') ?? '').toLowerCase().includes('ollama'),
      ),
    ).toBe(false)
  })

  it('keeps the chip button adding a key when clicked', async () => {
    await renderExpanded()
    const chip = Array.from(container.querySelectorAll('button')).find(b =>
      b.textContent?.includes('OpenRouter'),
    )!
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onAddKey).toHaveBeenCalledWith('openrouter')
  })
})
