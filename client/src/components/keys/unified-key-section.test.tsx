// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { UnifiedKeySection } from './unified-key-section'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The component builds its dev-mode base URL from the vite-injected port.
  ;(globalThis as unknown as Record<string, unknown>).__SERVER_PORT__ = '3001'
})

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  act(() => root.render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en"><UnifiedKeySection /></I18nProvider>
    </QueryClientProvider>,
  ))
  return flush()
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
}

async function click(el: HTMLElement) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush()
}

it('does not regenerate the key on a single click', async () => {
  vi.mocked(apiFetch).mockImplementation(async path =>
    path === '/api/settings/api-key' ? { apiKey: 'sk-fre…e-key' } : { ok: true })
  await mount()

  await click(findButton('Regenerate')!)
  // One click only ARMS the button (the dashboard's destructive idiom); the
  // endpoint that revokes the live key must not have been hit yet.
  expect(apiFetch).not.toHaveBeenCalledWith('/api/settings/api-key/regenerate', expect.anything())
  expect(findButton('Confirm')).toBeTruthy()
})

it('regenerates on the confirming click and reveals the fresh key', async () => {
  const calls = { regenerate: 0 }
  vi.mocked(apiFetch).mockImplementation(async path => {
    if (path === '/api/settings/api-key') {
      return { apiKey: calls.regenerate ? 'sk-fresh-key-after-regen' : 'sk-old-key-before-regen' }
    }
    if (path === '/api/settings/api-key/regenerate') { calls.regenerate++; return { apiKey: 'sk-fresh-key-after-regen' } }
    return { ok: true }
  })
  await mount()

  await click(findButton('Regenerate')!)
  await click(findButton('Confirm')!)
  expect(calls.regenerate).toBe(1)

  // The fresh key is shown unmasked right after: the user is about to paste
  // it into every app that still holds the revoked one.
  const code = container.querySelector('code.select-all')!
  expect(code.textContent).toContain('sk-fresh-key-after-regen')
})

it('keeps the key masked when the user disarms the confirmation', async () => {
  vi.mocked(apiFetch).mockImplementation(async path =>
    path === '/api/settings/api-key' ? { apiKey: 'sk-secret-value-123' } : { ok: true })
  await mount()

  await click(findButton('Regenerate')!)
  // Escape disarms the armed button without firing anything.
  await act(async () => {
    findButton('Confirm')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await flush()
  expect(apiFetch).not.toHaveBeenCalledWith('/api/settings/api-key/regenerate', expect.anything())
  expect(container.querySelector('code.select-all')!.textContent).not.toContain('sk-secret-value-123')
})

it('never shows the revoked key unmasked while the new one loads', async () => {
  // The GET refetch never resolves after regeneration: the fresh key must
  // come straight from the regenerate response, not from a refetch.
  let regenerated = false
  vi.mocked(apiFetch).mockImplementation(async path => {
    if (path === '/api/settings/api-key') {
      return regenerated ? new Promise(() => {}) : { apiKey: 'sk-old-key-before-regen' }
    }
    if (path === '/api/settings/api-key/regenerate') { regenerated = true; return { apiKey: 'sk-fresh-key-after-regen' } }
    return { ok: true }
  })
  await mount()

  const seen: string[] = []
  const code = () => container.querySelector('code.select-all')!
  const observer = new MutationObserver(() => seen.push(code().textContent ?? ''))
  observer.observe(container, { subtree: true, characterData: true, childList: true })

  await click(findButton('Regenerate')!)
  await click(findButton('Confirm')!)
  observer.disconnect()

  expect(seen.some(text => text.includes('sk-old-key-before-regen'))).toBe(false)
  expect(code().textContent).toContain('sk-fresh-key-after-regen')
})
