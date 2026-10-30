// @vitest-environment jsdom
// GLIXEL chat: streams through POST /api/glixel/chat, shows the router's real
// route under each reply, saves to the existing conversation store, explains
// errors, stops on demand, and never deletes history without a second tap.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { App } from '@/App'
import { SESSION_TOKEN_KEY } from '@/lib/session'

let root: Root
let container: HTMLDivElement
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are inspected loosely
type Body = any
type Call = { method: string; url: string; body: Body; signal?: AbortSignal | null }
let calls: Call[]
let chatReply: (body: Body, signal?: AbortSignal | null) => Response

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const sse = (chunks: string[]) => new Response(new ReadableStream({
  start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close() },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const STORED = {
  id: 7, title: 'Earlier chat',
  messages: [
    { role: 'user', content: 'What is GLIXEL?' },
    { role: 'assistant', content: 'Your assistant.', meta: { platform: 'cerebras', model: 'gpt-oss-120b', latency: 900, fallbackAttempts: 0 } },
  ],
}

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  localStorage.setItem(SESSION_TOKEN_KEY, 'session-token')
  window.location.hash = ''
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  calls = []
  chatReply = () => sse([
    ev({ type: 'route', platform: 'groq', model: 'llama-3.3-70b-versatile', displayName: 'Llama', fallbackAttempts: 1, fallbackTrail: 'google/gemini-3.5-flash key1=rate_limited' }),
    ev({ type: 'delta', text: 'Hello, ' }), ev({ type: 'delta', text: 'I am GLIXEL.' }),
    ev({ type: 'done', finishReason: 'stop', latencyMs: 1500 }),
  ])
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body, signal: init.signal })
    if (url === '/api/glixel/chat') return chatReply(body, init.signal)
    if (url === '/api/conversations' && method === 'POST') return json({ id: 9, title: body.title }, 201)
    if (url === '/api/conversations' && method === 'GET') return json([{ id: 7, title: 'Earlier chat', updatedAt: Date.UTC(2026, 9, 28) }])
    if (url === '/api/conversations/7' && method === 'GET') return json(STORED)
    if (url.startsWith('/api/conversations/') && (method === 'PUT' || method === 'DELETE')) return json({})
    return json({}, 404)
  }))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals() })

async function settle(n = 8) { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount() { act(() => root.render(<App />)); await settle() }
const $ = (sel: string) => container.querySelector(sel) as HTMLElement | null
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement
async function type(text: string) {
  const ta = $('#glixel-input') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { setter.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function send(text: string) { await type(text); await act(async () => { button('Send').click() }); await settle() }
const bubbles = () => [...container.querySelectorAll('[data-testid="message"]')].map(li => ({ role: li.getAttribute('data-role'), text: li.querySelector('[data-testid="message-text"]')?.textContent ?? '' }))

describe('GLIXEL chat', () => {
  it('opens on the chat tab and streams a reply with the real route under it', async () => {
    await mount()
    expect($('[aria-label="Chat with GLIXEL"]')).not.toBeNull()
    await send('Who are you?')
    const msgs = bubbles()
    expect(msgs[0]).toEqual({ role: 'user', text: 'Who are you?' })
    expect(msgs[1].text).toMatch(/^Hello, I am GLIXEL\./)
    const chip = $('[data-testid="route-chip"]')!.textContent!
    expect(chip).toMatch(/via groq · llama-3\.3-70b-versatile · 1 fallback · 1\.5 s/)
    expect(chip).toMatch(/skipped: google\/gemini-3\.5-flash key1=rate_limited/)
  })

  it('sends only user/assistant turns and saves the exchange with its route', async () => {
    await mount()
    await send('First question')
    const chat = calls.find(c => c.url === '/api/glixel/chat')!
    expect(chat.body).toEqual({ messages: [{ role: 'user', content: 'First question' }] })
    const created = calls.find(c => c.url === '/api/conversations' && c.method === 'POST')!
    expect(created.body.title).toBe('First question')
    expect(created.body.model).toBe('auto')
    expect(created.body.messages[1].meta).toEqual({ platform: 'groq', model: 'llama-3.3-70b-versatile', latency: 1500, fallbackAttempts: 1 })

    await send('Second question')
    const second = calls.filter(c => c.url === '/api/glixel/chat')[1]
    expect(second.body.conversationId).toBe(9)
    expect(second.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(calls.some(c => c.method === 'PUT' && c.url === '/api/conversations/9')).toBe(true)
  })

  it('explains an error and keeps it out of the next request', async () => {
    chatReply = () => json({ error: { message: 'Free-only routing refused every candidate.', code: 'free_only_blocked' } }, 403)
    await mount()
    await send('hi')
    expect(bubbles()[1].text).toMatch(/Free-only routing refused/)
    expect($('[data-testid="error-hint"]')!.textContent).toMatch(/Add a key for a free provider/)
    chatReply = () => sse([ev({ type: 'route', platform: 'groq', model: 'm', displayName: 'm', fallbackAttempts: 0, fallbackTrail: null }), ev({ type: 'delta', text: 'ok' }), ev({ type: 'done', finishReason: 'stop', latencyMs: 10 })])
    await send('again')
    const second = calls.filter(c => c.url === '/api/glixel/chat')[1]
    expect(second.body.messages).toEqual([{ role: 'user', content: 'hi' }, { role: 'user', content: 'again' }])
  })

  it('Stop aborts the request in flight', async () => {
    let signal: AbortSignal | null | undefined
    chatReply = (_b, s) => {
      signal = s
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(ev({ type: 'route', platform: 'groq', model: 'm', displayName: 'm', fallbackAttempts: 0, fallbackTrail: null })))
          s?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    await mount()
    await type('long question')
    await act(async () => { button('Send').click() })
    await settle(3)
    await act(async () => { button('Stop').click() })
    await settle()
    expect(signal?.aborted).toBe(true)
    expect(bubbles()[1].text).toBe('Stopped.')
    expect(button('Send')).toBeTruthy()
  })

  it('reopens a stored conversation with its saved route', async () => {
    await mount()
    await act(async () => { button('History').click() })
    await settle()
    await act(async () => { ([...container.querySelectorAll('[data-testid="history"] button')][0] as HTMLButtonElement).click() })
    await settle()
    expect(bubbles().map(b => b.role)).toEqual(['user', 'assistant'])
    expect($('[data-testid="route-chip"]')!.textContent).toMatch(/via cerebras · gpt-oss-120b · 900 ms/)
  })

  it('deletes history only after an explicit confirmation', async () => {
    await mount()
    await act(async () => { button('History').click() })
    await settle()
    await act(async () => { ($('[aria-label="Delete Earlier chat"]') as HTMLButtonElement).click() })
    expect($('[data-testid="confirm-delete"]')!.textContent).toMatch(/cannot be undone/)
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
    await act(async () => { button('Cancel').click() })
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
    await act(async () => { ($('[aria-label="Delete Earlier chat"]') as HTMLButtonElement).click() })
    await act(async () => { button('Delete').click() })
    await settle()
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual(['/api/conversations/7'])
  })

  it('switches to the control room without leaving the app', async () => {
    await mount()
    await act(async () => { button('Control').click() })
    await settle()
    expect(window.location.hash).toBe('#control')
    expect(container.querySelector('[data-telemetry="GET /api/providers"]')).not.toBeNull()
  })
})
