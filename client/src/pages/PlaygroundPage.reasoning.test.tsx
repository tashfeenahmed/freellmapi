// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import en from '@/i18n/locales/en.json'
import PlaygroundPage from './PlaygroundPage'

let root: Root
let container: HTMLDivElement
let client: QueryClient

const fallbackModels = [
  {
    modelDbId: 1,
    priority: 1,
    enabled: true,
    platform: 'google',
    modelId: 'gemini-2.5-flash',
    canonicalId: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    sizeLabel: 'Large',
    intelligenceRank: 1,
    supportsVision: true,
    reasoningCapabilities: {
      supported: true,
      efforts: ['none', 'low', 'medium', 'high'],
      supportsThinkingBudget: true,
    },
    keyCount: 1,
  },
  {
    modelDbId: 2,
    priority: 2,
    enabled: true,
    platform: 'mistral',
    modelId: 'mistral-large',
    canonicalId: 'mistral-large',
    displayName: 'Mistral Large',
    sizeLabel: 'Large',
    intelligenceRank: 2,
    supportsVision: false,
    reasoningCapabilities: {
      supported: false,
      efforts: [],
      supportsThinkingBudget: false,
    },
    keyCount: 1,
  },
  {
    modelDbId: 3,
    priority: 3,
    enabled: true,
    platform: 'sail',
    modelId: 'openai/gpt-oss-120b',
    canonicalId: 'gpt-oss-120b',
    displayName: 'GPT OSS 120B',
    sizeLabel: 'Frontier',
    intelligenceRank: 1,
    supportsVision: false,
    reasoningCapabilities: {
      supported: true,
      efforts: ['none', 'low', 'medium', 'high', 'max'],
      supportsThinkingBudget: false,
    },
    keyCount: 1,
  },
]

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView ??= () => {}
  window.matchMedia ??= vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} })
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
})

beforeEach(() => {
  localStorage.clear()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  client.setQueryData(['unified-key'], { apiKey: 'gateway-key' })
  client.setQueryData(['fallback'], fallbackModels)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string | URL) => {
    const href = String(url)
    if (href.includes('/api/conversations')) {
      return new Response(JSON.stringify({ id: 1, title: 'Test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  client.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderPlayground(initialModel: string) {
  localStorage.setItem('playground.model', initialModel)
  localStorage.setItem('playground.settingsOpen', 'true')
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><PlaygroundPage /></I18nProvider>
    </QueryClientProvider>,
  ))
}

async function sendPrompt(text: string) {
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="liquid-composer"] textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const sendButton = container.querySelector<HTMLButtonElement>(`button[aria-label="${en.playground.send}"]`)!
  await act(async () => sendButton.click())
}

describe('Playground reasoning controls', () => {
  it('defaults to Medium for supported models and forwards reasoning_effort + optional thinking_budget', async () => {
    await renderPlayground('gemini-2.5-flash')

    const mediumBtn = container.querySelector<HTMLButtonElement>('button[role="radio"][data-effort="medium"]')!
    expect(mediumBtn.getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('button[role="radio"][data-effort="max"]')).toBeNull()

    const highBtn = container.querySelector<HTMLButtonElement>('button[role="radio"][data-effort="high"]')!
    await act(async () => highBtn.click())
    expect(highBtn.getAttribute('aria-checked')).toBe('true')

    const budgetSwitch = container.querySelector<HTMLElement>(`[role="switch"][aria-label="${en.playground.thinkingBudget}"]`)!
    await act(async () => budgetSwitch.click())

    await sendPrompt('Hello')
    const completionCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/v1/chat/completions'))
    expect(completionCall).toBeDefined()
    const body = JSON.parse(String(completionCall![1]!.body))
    expect(body.reasoning_effort).toBe('high')
    expect(body.thinking_budget).toBe(8192)
  })

  it('shows Maximum when the provider supports it and hides thinking budget when unsupported', async () => {
    await renderPlayground('gpt-oss-120b')

    const maxBtn = container.querySelector<HTMLButtonElement>('button[role="radio"][data-effort="max"]')!
    expect(maxBtn).not.toBeNull()
    expect(container.querySelector('#playground-thinking-budget')).toBeNull()

    await act(async () => maxBtn.click())
    await sendPrompt('Solve')
    const completionCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/v1/chat/completions'))
    const body = JSON.parse(String(completionCall![1]!.body))
    expect(body.reasoning_effort).toBe('max')
    expect(body).not.toHaveProperty('thinking_budget')
  })

  it('shows unsupported notice and omits reasoning fields for models without reasoning support', async () => {
    await renderPlayground('mistral-large')

    expect(container.textContent).toContain(en.playground.reasoningUnsupported)
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()

    await sendPrompt('Hi')
    const completionCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/v1/chat/completions'))
    const body = JSON.parse(String(completionCall![1]!.body))
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('thinking_budget')
  })
})
