// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorHint, parseSseChunk, streamChat, toChatTurns } from './chat'
import { apiSend, isWritable, SESSION_TOKEN_KEY } from './session'

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

const sseResponse = (chunks: string[], status = 200) => new Response(new ReadableStream({
  start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close() },
}), { status, headers: { 'content-type': 'text/event-stream' } })
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

describe('parseSseChunk', () => {
  it('returns complete events and keeps a partial tail', () => {
    const { events, rest } = parseSseChunk('data: {"type":"delta","text":"a"}\n\ndata: {"type":"del')
    expect(events).toEqual([{ type: 'delta', text: 'a' }])
    expect(rest).toBe('data: {"type":"del')
  })
  it('ignores malformed lines', () => {
    expect(parseSseChunk('data: {nope\n\n').events).toEqual([])
  })
})

describe('toChatTurns', () => {
  it('drops error bubbles, empty turns and extra fields', () => {
    expect(toChatTurns([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Stopped.', isError: true },
      { role: 'assistant', content: '  ' },
      { role: 'user', content: 'again' },
    ])).toEqual([{ role: 'user', content: 'hi' }, { role: 'user', content: 'again' }])
  })
})

describe('write allowlist', () => {
  it('accepts only the listed method and path pairs', () => {
    for (const [m, p] of [['POST', '/api/glixel/chat'], ['POST', '/api/conversations'], ['PUT', '/api/conversations/12'], ['DELETE', '/api/conversations/12'],
      ['POST', '/api/keys'], ['POST', '/api/health/check/3'], ['PUT', '/api/fallback/routing']] as const) {
      expect(isWritable(m, p), `${m} ${p}`).toBe(true)
    }
    for (const [m, p] of [['DELETE', '/api/keys/3'], ['POST', '/api/keys/3/reveal'], ['POST', '/api/keys/import'], ['POST', '/api/settings/api-key/regenerate'],
      ['PUT', '/api/settings/proxy'], ['POST', '/v1/chat/completions'], ['POST', '/api/conversations/1/x'], ['POST', '/api/glixel/chat/x'],
      ['DELETE', '/api/conversations'], ['DELETE', '/api/fallback/penalty-inspector'], ['POST', '/api/health/check-all'], ['PUT', '/api/keys']] as const) {
      expect(isWritable(m, p), `${m} ${p}`).toBe(false)
    }
  })
  it('refuses other writes before the network', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(apiSend('POST', '/api/keys/1/reveal', {})).rejects.toThrow(/does not POST/)
    await expect(apiSend('DELETE', '/api/keys/1')).rejects.toThrow(/does not DELETE/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('streamChat', () => {
  it('collects the route, the text and the completion', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    const fetch = vi.fn(async () => sseResponse([
      ev({ type: 'route', platform: 'groq', model: 'm1', displayName: 'M1', fallbackAttempts: 1, fallbackTrail: 'google/g key1=rate_limited' }),
      ev({ type: 'delta', text: 'Hel' }), ev({ type: 'delta', text: 'lo' }),
      ev({ type: 'done', finishReason: 'stop', latencyMs: 1200 }),
    ]))
    vi.stubGlobal('fetch', fetch)
    const deltas: string[] = []
    const out = await streamChat([{ role: 'user', content: 'hi' }], { conversationId: 4, onDelta: d => deltas.push(d) })
    expect(out).toMatchObject({ text: 'Hello', finishReason: 'stop', latencyMs: 1200, error: null, aborted: false })
    expect(out.route).toEqual({ platform: 'groq', model: 'm1', displayName: 'M1', fallbackAttempts: 1, fallbackTrail: 'google/g key1=rate_limited' })
    expect(deltas).toEqual(['Hel', 'lo'])
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/glixel/chat')
    expect(JSON.parse(String(init.body))).toEqual({ messages: [{ role: 'user', content: 'hi' }], conversationId: 4 })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t')
  })

  it('surfaces a JSON error with its code', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'nope', code: 'free_only_blocked' } }), { status: 403, headers: { 'content-type': 'application/json' } })))
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.error).toEqual({ message: 'nope', code: 'free_only_blocked', status: 403 })
    expect(errorHint('free_only_blocked', 403)).toMatch(/Free-only routing/)
  })

  it('reports a stream that ends without done or error', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([ev({ type: 'delta', text: 'half' })])))
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.text).toBe('half')
    expect(out.error?.code).toBe('stream_incomplete')
  })

  it('reports an abort as aborted, not as an error', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError', init })
    }))
    const out = await streamChat([{ role: 'user', content: 'hi' }], { signal: controller.signal })
    expect(out.aborted).toBe(true)
    expect(out.error).toBeNull()
  })

  it('says when the server is unreachable, with the browser error and the ping result', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetch)
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.error?.code).toBe('network_error')
    expect(out.error?.message).toMatch(/Could not reach your FreeLLMAPI server \(TypeError: Failed to fetch, after \d+\.\d s\)\. It did not answer GET \/api\/ping either\./)
    expect(errorHint('network_error', null)).toMatch(/still running/)
    // the probe is the unauthenticated ping and carries no session
    const ping = fetch.mock.calls.find(c => (c as unknown[])[0] === '/api/ping') as unknown as [string, RequestInit]
    expect(ping[1].credentials).toBe('omit')
    expect(ping[1].headers).toBeUndefined()
  })

  it('tells a dropped chat connection apart from a server that is down', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/ping') return new Response('{"status":"ok"}', { status: 200 })
      throw new TypeError('network error')
    }))
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.error?.code).toBe('connection_dropped')
    expect(out.error?.message).toMatch(/server is running, but this chat request's connection failed after \d+\.\d s.*\(TypeError: network error\)/)
  })

  it('reports a stream cut mid-answer with what arrived, the browser error and the server state', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/ping') return new Response('{"status":"ok"}', { status: 200 })
      return new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(ev({ type: 'delta', text: 'partial' }))) },
        pull(c) { if (c.desiredSize !== null && c.desiredSize > 0) c.error(new TypeError('network error')) },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }))
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.text).toBe('partial')
    expect(out.error?.code).toBe('stream_interrupted')
    expect(out.error?.message).toMatch(/dropped after .* \(TypeError: network error\)\. The server is still running\./)
  })

  it('recognises a web page served where the API should be', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><title>x</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })))
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.error?.code).toBe('not_api')
    expect(errorHint('not_api', 200)).toMatch(/localhost:<port>\/glixel/)
  })

  it('reports an expired session from the server, not a network problem', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'expired')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Authentication required', type: 'authentication_error' } }), { status: 401, headers: { 'content-type': 'application/json' } })))
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.error).toMatchObject({ status: 401, message: 'Authentication required' })
    expect(errorHint(out.error!.code, 401)).toMatch(/Sign in on the dashboard again/)
  })

  it('keeps an abort during the failure probe an abort', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/ping') { controller.abort(); return new Response('{}', { status: 200 }) }
      throw new TypeError('Failed to fetch')
    }))
    const out = await streamChat([{ role: 'user', content: 'hi' }], { signal: controller.signal })
    expect(out.aborted).toBe(true)
  })
})
