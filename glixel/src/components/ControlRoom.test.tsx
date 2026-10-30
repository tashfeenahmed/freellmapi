// @vitest-environment jsdom
// Control Room contract: existing endpoints only, env-set policy shown as
// read-only, a routing change needs an explicit second step and sends only the
// strategy, a provider key leaves the browser once and is never shown again,
// and Claude cannot be selected while the server reports it unavailable.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { App } from '@/App'
import { SESSION_TOKEN_KEY } from '@/lib/session'

const SECRET = 'gsk_' + 'Z'.repeat(40)
let root: Root
let container: HTMLDivElement
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are inspected loosely
type Body = any
let calls: Array<{ method: string; url: string; body: Body }>
let healthStatus = 'healthy'
let addKeyStatus = 201

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const CAPS = {
  defaultProvider: 'freellmapi',
  providers: [
    { id: 'freellmapi', label: 'FreeLLMAPI', available: true, billing: 'free models only', reason: null },
    { id: 'claude', label: 'Claude', available: false, billing: 'paid API', reason: 'Claude is not connected. It needs an Anthropic API key.' },
  ],
  routing: { source: 'environment', freeOnly: { enabled: true, optedIn: [] }, fallbackMaxAttempts: 20 },
}
const PROVIDERS = {
  generatedAt: '2026-10-28T12:00:00.000Z', freeOnly: { enabled: true, optedIn: [] },
  providers: [{
    platform: 'groq', name: 'Groq', kind: 'chat', state: 'connected', automaticRouting: { eligible: true }, lastCheckedAt: null,
    models: { enabled: 2, automaticallyRoutable: 2 }, traffic24h: { requests: 0, successRate: null, avgLatencyMs: null }, cooldowns: { active: 0, soonestExpiresAt: null },
  }],
}
const ROUTING = {
  strategy: 'balanced',
  scores: [
    { platform: 'groq', modelId: 'llama-70b', displayName: 'Llama 70B', enabled: true, score: 0.7 },
    { platform: 'nvidia', modelId: 'other', displayName: 'Not connected', enabled: true, score: 0.9 },
  ],
}

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  localStorage.setItem(SESSION_TOKEN_KEY, 'session-token')
  window.location.hash = 'control'
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  calls = []; healthStatus = 'healthy'; addKeyStatus = 201
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body })
    if (url === '/api/glixel/capabilities') return json(CAPS)
    if (url === '/api/providers') return json(PROVIDERS)
    if (url === '/api/health') return json({ degradation: { state: 'normal', healthyProviders: 1, totalProviders: 1, ratio: 1, degradedAt: null } })
    if (url === '/api/fallback/routing') return method === 'PUT' ? json({ success: true }) : json(ROUTING)
    if (url === '/api/keys/providers') return json({ providers: [
      { platform: 'groq', name: 'Groq', kind: 'chat', keyless: false, configured: true, keyCount: 1 },
      { platform: 'kilo', name: 'Kilo', kind: 'chat', keyless: true, configured: false, keyCount: 0 },
      { platform: 'tavily', name: 'Tavily', kind: 'search', keyless: false, configured: false, keyCount: 0 },
    ] })
    if (url === '/api/keys' && method === 'POST') {
      return addKeyStatus === 201
        ? json({ id: 42, platform: body.platform, maskedKey: 'gsk_ZZZ…ZZZZ', status: 'unknown' }, 201)
        : json({ error: { message: 'key is required' } }, addKeyStatus)
    }
    if (url === '/api/health/check/42') return json({ keyId: 42, status: healthStatus })
    if (url.startsWith('/api/analytics/requests')) return json({ total: 1, rows: [
      { id: 1, platform: 'groq', modelId: 'llama-70b', status: 'error', latencyMs: 300, error: 'rate limited', createdAt: '2026-10-28T11:00:00Z', attemptCount: 2 },
    ] })
    return json({}, 404)
  }))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals(); window.location.hash = '' })

async function settle(n = 10) { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount() { act(() => root.render(<App />)); await settle() }
const $ = (sel: string) => container.querySelector(sel) as HTMLElement | null
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement
async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

describe('Control Room', () => {
  it('reads only existing GET endpoints on open', async () => {
    await mount()
    expect(calls.every(c => c.method === 'GET')).toBe(true)
    expect(new Set(calls.map(c => c.url.split('?')[0]))).toEqual(new Set([
      '/api/providers', '/api/health', '/api/glixel/capabilities', '/api/fallback/routing', '/api/keys/providers', '/api/analytics/requests',
    ]))
  })

  it('offers FreeLLMAPI and shows Claude as unavailable with the reason', async () => {
    await mount()
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[name="ai-path"]')]
    expect(radios.map(r => [r.value, r.checked, r.disabled])).toEqual([['freellmapi', true, false], ['claude', false, true]])
    expect($('[data-testid="ai-path-section"]')!.textContent).toMatch(/Anthropic API key/)
    expect($('[data-testid="ai-path-section"]')!.textContent).toMatch(/never switches to another path, or to a paid one/)
  })

  it('shows env-set policy read-only and lists only models on usable providers', async () => {
    await mount()
    expect($('[data-testid="cr-free-only"]')!.textContent).toBe('On')
    expect($('[data-testid="cr-max-attempts"]')!.textContent).toBe('20')
    expect($('[data-testid="routing-section"]')!.textContent).toMatch(/Read-only here.*FREE_ONLY_ROUTING/)
    const models = $('[data-testid="cr-models"]')!.textContent!
    expect(models).toMatch(/Llama 70B/)
    expect(models).not.toMatch(/Not connected/)
  })

  it('changes the routing strategy only after confirmation, sending nothing but the strategy', async () => {
    await mount()
    await setValue($('#cr-strategy-pick') as HTMLSelectElement, 'fastest')
    await act(async () => { button('Apply').click() })
    expect($('[data-testid="confirm-strategy"]')!.textContent).toMatch(/every app using this FreeLLMAPI server/)
    expect(calls.some(c => c.method === 'PUT')).toBe(false)
    await act(async () => { button('Cancel').click() })
    expect(calls.some(c => c.method === 'PUT')).toBe(false)
    await act(async () => { button('Apply').click() })
    await act(async () => { button('Switch to fastest').click() })
    await settle()
    expect(calls.filter(c => c.method === 'PUT')).toEqual([{ method: 'PUT', url: '/api/fallback/routing', body: { strategy: 'fastest' } }])
  })

  it('sends a key once, clears it, checks it, and never displays it or its mask', async () => {
    await mount()
    const select = $('#cr-platform') as HTMLSelectElement
    expect([...select.options].map(o => o.value)).toEqual(['', 'groq']) // keyless and search providers are left to the dashboard
    await setValue(select, 'groq')
    const input = $('#cr-key') as HTMLInputElement
    expect(input.type).toBe('password')
    await setValue(input, SECRET)
    await act(async () => { button('Save key').click() })
    await settle()
    const posts = calls.filter(c => c.method === 'POST')
    expect(posts.map(c => c.url)).toEqual(['/api/keys', '/api/health/check/42'])
    expect(posts[0].body).toEqual({ platform: 'groq', key: SECRET })
    expect(posts[1].body).toBeNull()
    expect(input.value).toBe('')
    expect($('[data-testid="add-key-result"]')!.textContent).toMatch(/Groq accepted the key/)
    expect(container.innerHTML).not.toContain(SECRET)
    expect(container.innerHTML).not.toContain('gsk_ZZZ')
    expect(calls.filter(c => c.url.includes(SECRET))).toHaveLength(0)
    expect(Object.keys(localStorage)).toEqual([SESSION_TOKEN_KEY])
  })

  it('reports a key the provider rejected, and a save the server refused', async () => {
    healthStatus = 'invalid'
    await mount()
    await setValue($('#cr-platform') as HTMLSelectElement, 'groq')
    await setValue($('#cr-key') as HTMLInputElement, SECRET)
    await act(async () => { button('Save key').click() })
    await settle()
    expect($('[data-testid="add-key-result"]')!.textContent).toMatch(/reported "invalid"/)

    addKeyStatus = 400
    await setValue($('#cr-key') as HTMLInputElement, SECRET)
    await act(async () => { button('Save key').click() })
    await settle()
    expect($('[data-testid="add-key-result"]')!.textContent).toBe('Not saved: key is required')
    expect(($('#cr-key') as HTMLInputElement).value).toBe('')
  })

  it('lists recent request outcomes without client details', async () => {
    await mount()
    const text = $('[data-testid="recent-requests"]')!.textContent!
    expect(text).toMatch(/error.*groq\/llama-70b.*2 tries/s)
    expect(text).toMatch(/rate limited/)
  })
})
