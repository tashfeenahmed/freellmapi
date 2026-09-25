// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import type { Model } from '@freellmapi/shared/types'
import { TestModelsDialog } from './test-models-dialog'
import { selectTestableModels } from '@/lib/test-models'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))

function model(over: Partial<Model> & Pick<Model, 'id' | 'platform' | 'modelId'>): Model {
  return {
    displayName: over.modelId, intelligenceRank: 50, speedRank: 50, sizeLabel: 'M',
    rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null, monthlyTokenBudget: '0',
    contextWindow: null, enabled: true, supportsVision: false, supportsTools: true,
    ...over,
  }
}

const MODELS: Model[] = [
  model({ id: 1, platform: 'groq', modelId: 'llama-8b', displayName: 'Llama 8B', intelligenceRank: 40 }),
  model({ id: 2, platform: 'groq', modelId: 'llama-70b', displayName: 'Llama 70B', intelligenceRank: 12 }),
  model({ id: 3, platform: 'google', modelId: 'gemini-flash', displayName: 'Gemini Flash', intelligenceRank: 8 }),
  model({ id: 4, platform: 'custom', modelId: 'relay-a-model', displayName: 'Relay A model', keyId: 7 }),
  model({ id: 5, platform: 'custom', modelId: 'relay-b-model', displayName: 'Relay B model', keyId: 8 }),
]

describe('selectTestableModels', () => {
  it('keeps one provider, smartest first', () => {
    expect(selectTestableModels(MODELS, 'groq').map(m => m.modelId)).toEqual(['llama-70b', 'llama-8b'])
  })
  it('narrows a custom endpoint to the models bound to that key', () => {
    expect(selectTestableModels(MODELS, 'custom', 7).map(m => m.modelId)).toEqual(['relay-a-model'])
  })
})

describe('TestModelsDialog', () => {
  let root: Root
  let container: HTMLDivElement
  const onOpenChange = vi.fn()
  beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
    onOpenChange.mockReset()
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })
  async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
  async function mount(platform: string, keyId?: number) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    act(() => root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <TestModelsDialog platform={platform} keyId={keyId} label="Groq" onOpenChange={onOpenChange} />
        </I18nProvider>
      </QueryClientProvider>,
    ))
    await flush()
  }
  const testButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Test "]')]

  it('lists only the provider\'s models and fires the pinned test for the clicked one', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/models') return MODELS
      if (path === '/api/models/2/test') return { success: true, modelId: 'llama-70b', latencyMs: 321 }
      throw new Error(`unexpected ${path}`)
    })
    await mount('groq')
    const list = container.querySelector('[data-testid="test-models-list"]')!
    expect(list.textContent).toContain('Llama 70B')
    expect(list.textContent).toContain('Llama 8B')
    expect(list.textContent).not.toContain('Gemini Flash')
    expect(list.textContent).not.toContain('Relay A model')

    act(() => { testButtons()[0].click() })
    await flush()
    const testCalls = vi.mocked(apiFetch).mock.calls.filter(([p]) => String(p).endsWith('/test'))
    expect(testCalls).toEqual([['/api/models/2/test', { method: 'POST' }]])
    expect(list.textContent).toContain('Pass')
    expect(list.textContent).toContain('321ms')
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('shows the provider\'s reason on a failed test and does not re-fire within the throttle window', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/models') return MODELS
      if (path === '/api/models/3/test') return { success: false, modelId: 'gemini-flash', latencyMs: 40, error: 'Google API error 429: quota' }
      throw new Error(`unexpected ${path}`)
    })
    await mount('google')
    act(() => { testButtons()[0].click() })
    await flush()
    expect(container.textContent).toContain('Failed')
    expect(container.textContent).toContain('Google API error 429: quota')
    expect(toast.error).toHaveBeenCalledTimes(1)

    // Second click inside the 5s window is refused client-side (no second request).
    act(() => { testButtons()[0].click() })
    await flush()
    const testCalls = vi.mocked(apiFetch).mock.calls.filter(([p]) => String(p).endsWith('/test'))
    expect(testCalls).toHaveLength(1)
    expect(toast.error).toHaveBeenCalledTimes(2)
    expect(vi.mocked(toast.error).mock.calls[1][0]).toMatch(/wait \d+s/)
  })

  it('says so when a custom key has no models yet', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => MODELS)
    await mount('custom', 99)
    expect(container.querySelector('[data-testid="test-models-list"]')).toBeNull()
    expect(container.textContent).toContain('No models configured for this provider.')
  })
})
