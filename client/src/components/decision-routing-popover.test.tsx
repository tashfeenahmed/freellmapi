// @vitest-environment jsdom
// The 'decision' strategy's settings popover (#1354): pick the decision model
// and the minimum confidence, see since-restart picks, warn when nothing can
// decide. Nothing is saved until Apply.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { DecisionRoutingStatus } from '@/lib/routing'
import { DecisionRoutingPopover, DecisionSetupGuide } from './decision-routing-popover'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const status = (over: Partial<DecisionRoutingStatus> = {}): DecisionRoutingStatus => ({
  model: 'auto', minProbability: 0.5, ready: true, hasModels: true, keyPlatforms: ['cloudflare', 'openrouter'],
  counts: { smartest: 3, fastest: 5, balanced: 2, reliable: 0 }, fallbacks: { low_confidence: 1 }, ...over,
})

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/decisions/models') {
      return [
        { id: 1, platform: 'cloudflare', modelId: '@cf/cloudflare/clef-flash', displayName: 'Clef Flash', priority: 0, enabled: true },
        { id: 2, platform: 'openrouter', modelId: 'inception/mercury-decide:free', displayName: 'Mercury Decide (free)', priority: 1, enabled: false },
      ]
    }
    return {}
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); document.body.innerHTML = '' })

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
// Shows where a navigation went, so a test can assert on the URL.
function WhereAmI() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname + loc.search}</div>
}

async function render(node: React.ReactNode) {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={['/fallback']}>
          <Routes>
            <Route path="/fallback" element={node} />
            <Route path="*" element={<WhereAmI />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  ))
  await flush()
}

async function click(label: string, root: ParentNode = document.body) {
  const button = [...root.querySelectorAll('button')].find(b => b.textContent?.includes(label)) as HTMLButtonElement
  expect(button, `button "${label}"`).toBeTruthy()
  await act(async () => { button.click() })
  await flush()
}

const where = () => document.body.querySelector('[data-testid="where"]')?.textContent

async function open(s: DecisionRoutingStatus, onSave = vi.fn()) {
  await render(<DecisionRoutingPopover status={s} saving={false} onSave={onSave} />)
  const trigger = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Adjust')) as HTMLButtonElement
  await act(async () => { trigger.click() })
  await flush()
  return onSave
}

const body = () => document.body.textContent ?? ''

it('shows settings, enabled decision models and since-restart picks', async () => {
  await open(status())
  expect(body()).toContain('Decision routing')
  const select = document.body.querySelector('select') as HTMLSelectElement
  expect([...select.options].map(o => o.textContent)).toEqual(['Auto (first available)', 'Clef Flash'])
  expect(body()).toContain('Picks since restart (10)')
  expect(body()).toContain('1 routed as Balanced')
  expect(body()).not.toContain('No decision model is ready')
})

it('warns when no decision model can answer, with a button to the missing key', async () => {
  await open(status({ ready: false, counts: { smartest: 0, fastest: 0, balanced: 0, reliable: 0 }, fallbacks: {} }))
  expect(body()).toContain('No decision model is ready')
  expect(body()).not.toContain('Picks since restart')
  await click('Add OpenRouter key')
  expect(where()).toBe('/keys?add=openrouter')
})

it('saves the chosen model and minimum confidence only on Apply', async () => {
  const onSave = await open(status())
  const select = document.body.querySelector('select') as HTMLSelectElement
  const slider = document.body.querySelector('input[type="range"]') as HTMLInputElement
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setValue.call(select, '@cf/cloudflare/clef-flash')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(slider, '70')
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(onSave).not.toHaveBeenCalled()
  const apply = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Apply') as HTMLButtonElement
  await act(async () => { apply.click() })
  expect(onSave).toHaveBeenCalledWith({ decisionModel: '@cf/cloudflare/clef-flash', decisionMinProbability: 0.7 })
})

describe('Decision setup guide (pill without a usable key)', () => {
  const notReady = status({ ready: false, counts: { smartest: 0, fastest: 0, balanced: 0, reliable: 0 }, fallbacks: {} })

  it('opens a guide with one Add key button per provider instead of switching', async () => {
    await render(<DecisionSetupGuide status={notReady} className="pill">Decision</DecisionSetupGuide>)
    await click('Decision', container)
    expect(body()).toContain('Add a free key to use Decision')
    const adds = [...document.body.querySelectorAll('button')].map(b => b.textContent).filter(t => t?.startsWith('Add '))
    expect(adds).toEqual(['Add Cloudflare Workers AI key', 'Add OpenRouter key'])
    // The guide never changes the routing strategy itself.
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/fallback/routing')).toBe(false)
  })

  it('takes the user to Keys with the provider preselected', async () => {
    await render(<DecisionSetupGuide status={notReady} className="pill">Decision</DecisionSetupGuide>)
    await click('Decision', container)
    await click('Add Cloudflare Workers AI key')
    expect(where()).toBe('/keys?add=cloudflare')
  })

  it('points at Models → Decision when no decision model is turned on', async () => {
    await render(<DecisionSetupGuide status={{ ...notReady, hasModels: false, keyPlatforms: [] }} className="pill">Decision</DecisionSetupGuide>)
    await click('Decision', container)
    expect(body()).toContain('No decision model is turned on yet')
    await click('Open decision models')
    expect(where()).toBe('/models/decision')
  })
})
