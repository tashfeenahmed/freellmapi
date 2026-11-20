// @vitest-environment jsdom
// Models → Decision lists the catalog's decision models, toggles one with
// PATCH, and "Try it" runs one choice question through /api/decisions/try.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { DecisionModel } from '@/lib/decision'
import { DecisionModelsView } from './decision-models'
import { ModelsTabs } from './models-tabs'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const model = (over: Partial<DecisionModel>): DecisionModel => ({
  id: 1, platform: 'cloudflare', modelId: '@cf/cloudflare/clef-flash', displayName: 'Clef Flash', priority: 0,
  enabled: true, quotaLabel: 'Workers AI free daily neurons', contextWindow: 24576,
  keyCount: 1, healthyKeyCount: 1, decisionsThisMonth: 4, ...over,
})

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(models: DecisionModel[]) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/decisions/models') return models
    if (path.endsWith('/test')) {
      return { success: true, model: '@cf/cloudflare/clef-flash', provider: 'cloudflare', latencyMs: 812, answer: 'positive' }
    }
    if (path === '/api/decisions/try') {
      return {
        model: '@cf/cloudflare/clef-flash', provider: 'cloudflare', usage: { input_tokens: 10, output_tokens: 0 },
        answers: { answer: { type: 'choice', choice: 'code', confidence: 0.91, probabilities: { chat: 0.04, code: 0.93, reasoning: 0.03 } } },
      }
    }
    return {}
  })
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MemoryRouter><DecisionModelsView /></MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  ))
  await flush()
}

it('lists the decision models with usage and a no-key badge', async () => {
  await mount([
    model({}),
    model({ id: 2, platform: 'openrouter', modelId: 'inception/mercury-decide:free', displayName: 'Mercury Decide (free)', priority: 1, keyCount: 0, healthyKeyCount: 0, decisionsThisMonth: 0 }),
  ])
  const text = container.textContent ?? ''
  expect(text).toContain('Clef Flash')
  expect(text).toContain('inception/mercury-decide:free')
  expect(text).toContain('4 this month')
  expect(text).toContain('POST /v1/decisions')
  expect(text).toContain('Chat routing only uses them when the Decision routing strategy is on')
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2)
})

it('turns a model off with PATCH', async () => {
  await mount([model({})])
  const toggle = container.querySelector('[role="switch"]') as HTMLElement
  await act(async () => { toggle.click() })
  await flush()
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/decisions/models/1', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
})

it('runs a test decision and shows the answer with probabilities', async () => {
  await mount([model({})])
  const run = [...container.querySelectorAll('button')].find(b => b.textContent === 'Decide') as HTMLButtonElement
  await act(async () => { run.click() })
  await flush()
  const call = vi.mocked(apiFetch).mock.calls.find(c => c[0] === '/api/decisions/try')!
  expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
    state: 'my react useEffect runs twice, why?',
    question: 'Which kind of model should answer this?',
    options: ['chat', 'code', 'reasoning', 'writing'],
  })
  const text = container.textContent ?? ''
  expect(text).toContain('Answer: code')
  expect(text).toContain('91% confident')
  expect(text).toContain('93%')
})

it('tests one decision model from its card', async () => {
  await mount([model({})])
  const test = [...container.querySelectorAll('button')].find(b => b.textContent === 'Test') as HTMLButtonElement
  await act(async () => { test.click() })
  await flush()
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/decisions/models/1/test', { method: 'POST' })
  expect(container.textContent).toContain('@cf/cloudflare/clef-flash · 812 ms')
})

it('does not offer a test for a model with no key', async () => {
  await mount([model({ keyCount: 0, healthyKeyCount: 0 })])
  const test = [...container.querySelectorAll('button')].find(b => b.textContent === 'Test') as HTMLButtonElement
  expect(test.disabled).toBe(true)
})

it('shows the empty state before the catalog syncs', async () => {
  await mount([])
  expect(container.textContent).toContain('No decision models yet')
})

it('orders the Models tabs with Embeddings after Audio and Decision next to it', () => {
  act(() => root.render(
    <I18nProvider initialLocale="en"><MemoryRouter><ModelsTabs /></MemoryRouter></I18nProvider>
  ))
  const labels = [...container.querySelectorAll('a')].map(a => a.textContent)
  expect(labels).toEqual(['Chat models', 'Image', 'Video', 'Audio', 'Embeddings', 'Decision', 'Search', 'Fusion'])
})
