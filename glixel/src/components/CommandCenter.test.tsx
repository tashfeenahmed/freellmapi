// @vitest-environment jsdom
// The command center's honesty contract: every figure sits in a telemetry
// panel that names its source; the animated core is decoration that reads no
// data and stops for reduced motion or a hidden page; no session means no data.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { App } from '@/App'
import { IntelligenceCore } from './IntelligenceCore'
import { SESSION_TOKEN_KEY } from '@/lib/session'
import type { HealthTelemetry, ProvidersTelemetry } from '@/lib/telemetry'

const PROVIDERS: ProvidersTelemetry = {
  generatedAt: '2026-10-28T12:00:00.000Z',
  freeOnly: { enabled: true, optedIn: [] },
  providers: [
    {
      platform: 'google', name: 'Google AI Studio', kind: 'chat', state: 'connected',
      automaticRouting: { eligible: true }, lastCheckedAt: '2026-10-28 11:59:00',
      models: { enabled: 6, automaticallyRoutable: 5 },
      traffic24h: { requests: 4, successRate: 0.75, avgLatencyMs: 3186 },
      cooldowns: { active: 1, soonestExpiresAt: null },
    },
    {
      platform: 'cohere', name: 'Cohere', kind: 'chat', state: 'unhealthy',
      automaticRouting: { eligible: false, reason: 'trial access' }, lastCheckedAt: null,
      models: { enabled: 2, automaticallyRoutable: 0 },
      traffic24h: { requests: 0, successRate: null, avgLatencyMs: null },
      cooldowns: { active: 0, soonestExpiresAt: null },
    },
    {
      platform: 'mistral', name: 'Mistral', kind: 'chat', state: 'unconfigured',
      automaticRouting: { eligible: false, reason: 'no enabled models' }, lastCheckedAt: null,
      models: { enabled: 0, automaticallyRoutable: 0 },
      traffic24h: { requests: 0, successRate: null, avgLatencyMs: null },
      cooldowns: { active: 0, soonestExpiresAt: null },
    },
  ],
}
const HEALTH: HealthTelemetry = { degradation: { state: 'normal', healthyProviders: 1, totalProviders: 2, ratio: 0.5, degradedAt: null } }

let root: Root
let container: HTMLDivElement
let reduceMotion = false
const listeners = new Set<() => void>()

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  reduceMotion = false
  listeners.clear()
  window.matchMedia = ((query: string) => ({
    get matches() { return query.includes('reduce') ? reduceMotion : false },
    media: query,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  })) as unknown as typeof window.matchMedia
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  localStorage.clear(); vi.unstubAllGlobals()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  window.location.hash = ''
})

function stubApi(responses: Record<string, () => Response>) {
  const fetch = vi.fn(async (url: string) => (responses[url] ?? (() => new Response('', { status: 404 })))())
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

async function render(node: React.ReactNode) {
  window.location.hash = 'status'
  act(() => root.render(node))
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}
const q = (sel: string) => container.querySelector(sel)
async function waitFor(check: () => boolean, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await act(async () => { await new Promise(r => setTimeout(r, 25)) })
  }
}
const text = (id: string) => q(`[data-testid="${id}"]`)?.textContent

describe('without a session', () => {
  it('shows the locked screen, links to the dashboard sign-in, and fetches nothing', async () => {
    const fetch = stubApi({})
    await render(<App />)
    expect(container.textContent).toMatch(/GLIXEL is locked/)
    expect((q('a[href="/"]') as HTMLAnchorElement).textContent).toMatch(/sign-in/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('locks again when the session is rejected', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'expired')
    stubApi({ '/api/providers': json({}, 401), '/api/health': json({}, 401) })
    await render(<App />)
    expect(container.textContent).toMatch(/GLIXEL is locked/)
  })
})

describe('with a session', () => {
  beforeEach(() => { localStorage.setItem(SESSION_TOKEN_KEY, 'session-token') })

  it('renders real figures from the existing endpoints', async () => {
    const fetch = stubApi({ '/api/providers': json(PROVIDERS), '/api/health': json(HEALTH) })
    await render(<App />)
    const urls = fetch.mock.calls.map(c => c[0])
    expect(urls).toEqual(expect.arrayContaining(['/api/health', '/api/providers']))
    expect(fetch.mock.calls.every(c => !(c as unknown[])[1] || !((c as unknown[])[1] as RequestInit).method)).toBe(true) // reads only
    expect(text('free-only')).toBe('On')
    expect(text('connected')).toBe('1')
    expect(text('auto-models')).toBe('5') // google is connected; cohere (unhealthy) and mistral (not set up) add nothing
    expect(text('requests')).toBe('4')
    expect(text('success')).toBe('75%')
    expect(text('latency')).toBe('3.2 s')
    expect(text('mode')).toBe('normal')
    const rows = q('[data-testid="provider-rows"]')!.textContent!
    expect(rows).toMatch(/Google AI Studio/)
    expect(rows).toMatch(/not used automatically: trial access/)
    expect(rows).not.toMatch(/Mistral/) // not set up: counted, not listed
  })

  it('puts every figure inside a telemetry panel that names its source and time', async () => {
    stubApi({ '/api/providers': json(PROVIDERS), '/api/health': json(HEALTH) })
    await render(<App />)
    for (const id of ['free-only', 'auto-models', 'connected', 'requests', 'success', 'latency', 'mode', 'provider-rows']) {
      const panel = q(`[data-testid="${id}"]`)!.closest('[data-telemetry]')
      expect(panel, id).not.toBeNull()
      expect(panel!.getAttribute('data-freshness'), id).toBe('live')
      expect(panel!.querySelector('footer')!.textContent, id).toMatch(/^GET \/api\/(providers|health) · (observed|fetched) /)
    }
  })

  it('keeps decoration free of data and hidden from assistive technology', async () => {
    stubApi({ '/api/providers': json(PROVIDERS), '/api/health': json(HEALTH) })
    await render(<App />)
    const decorative = [...container.querySelectorAll('[data-decorative="true"]')]
    expect(decorative.length).toBeGreaterThan(0)
    for (const d of decorative) {
      expect(d.getAttribute('aria-hidden')).toBe('true')
      expect(d.closest('[data-telemetry]')).toBeNull()
      expect(d.querySelector('[data-telemetry]')).toBeNull()
      expect(d.textContent).toBe('visual only') // no numbers, no status words
    }
    expect(text('legend')).toMatch(/visual only.*decoration, not data/s)
  })

  it('shows a failed endpoint as unavailable instead of filling in values', async () => {
    stubApi({ '/api/providers': json(PROVIDERS), '/api/health': json({}, 500) })
    await render(<App />)
    // One retry happens first (transient-failure policy), then the panel says so.
    await waitFor(() => q('[data-telemetry="GET /api/health"]')?.getAttribute('data-freshness') === 'unavailable')
    const health = q('[data-telemetry="GET /api/health"]')!
    expect(health.getAttribute('data-freshness')).toBe('unavailable')
    expect(health.textContent).toMatch(/No data: GET \/api\/health could not be read/)
    expect(text('mode')).toBeUndefined()
    expect(q('[data-telemetry="GET /api/providers"]')!.getAttribute('data-freshness')).toBe('live')
  })
})

describe('IntelligenceCore', () => {
  it('takes no props, so it cannot be bound to telemetry', () => {
    expect(IntelligenceCore.length).toBe(0)
  })

  it('animates by default', async () => {
    await render(<IntelligenceCore />)
    expect(q('svg')!.getAttribute('data-animating')).toBe('true')
  })

  it('stays still for reduced-motion users, and follows a live preference change', async () => {
    reduceMotion = true
    await render(<IntelligenceCore />)
    const svg = q('svg') as SVGElement
    expect(svg.getAttribute('data-animating')).toBe('false')
    expect(svg.style.animationPlayState).toBe('paused')
    reduceMotion = false
    await act(async () => { listeners.forEach(l => l()) })
    expect(q('svg')!.getAttribute('data-animating')).toBe('true')
  })

  it('pauses while the page is hidden and resumes when it is visible again', async () => {
    await render(<IntelligenceCore />)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(q('svg')!.getAttribute('data-animating')).toBe('false')
    const cell = q('rect') as SVGRectElement
    expect(cell.style.animationPlayState).toBe('paused')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(q('svg')!.getAttribute('data-animating')).toBe('true')
  })
})
