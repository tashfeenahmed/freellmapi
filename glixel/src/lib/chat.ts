// Client for POST /api/glixel/chat. The server owns the persona and routing;
// the app sends only the visible user/assistant turns and renders the stream.
import { ApiError, apiSend, RefusedWriteError } from './session'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Routing facts the router reported for this reply (never guessed). */
export interface RouteInfo {
  platform: string
  model: string
  displayName: string
  fallbackAttempts: number
  fallbackTrail: string | null
}

export interface ChatOutcome {
  route: RouteInfo | null
  text: string
  finishReason: string | null
  latencyMs: number | null
  /** Set when the request failed; `text` keeps whatever arrived first. */
  error: { message: string; code: string | null; status: number | null } | null
  aborted: boolean
}

export interface StreamHandlers {
  onRoute?: (route: RouteInfo) => void
  onDelta?: (text: string) => void
}

/** Turns stored history into what the server accepts: no error bubbles, no empties. */
export function toChatTurns(messages: Array<{ role: 'user' | 'assistant'; content: string; isError?: boolean }>): ChatTurn[] {
  return messages
    .filter(m => !m.isError && m.content.trim() !== '')
    .map(m => ({ role: m.role, content: m.content }))
}

/** Parses SSE `data:` lines; returns complete events and the unparsed tail. */
export function parseSseChunk(buffer: string): { events: Array<Record<string, unknown>>; rest: string } {
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  const events: Array<Record<string, unknown>> = []
  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try { events.push(JSON.parse(line.slice(6))) } catch { /* ignore a malformed line */ }
    }
  }
  return { events, rest }
}

/** The browser's own description of a failure, without request data. */
export function describeFailure(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 160)
  return String(err).slice(0, 160)
}

/**
 * Asks the unauthenticated GET /api/ping whether the server still answers, so
 * a failed chat request can say "server down" or "this connection was
 * dropped" instead of guessing. Sends no session or message data.
 */
export async function probeServer(timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch('/api/ping', { cache: 'no-store', credentials: 'omit', signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

async function connectionFailure(err: unknown, startedAt: number, phase: 'request' | 'stream'): Promise<{ message: string; code: string }> {
  const after = seconds(Date.now() - startedAt)
  const browser = describeFailure(err)
  const up = await probeServer()
  if (!up) {
    return { message: `Could not reach your FreeLLMAPI server (${browser}, after ${after}). It did not answer GET /api/ping either.`, code: 'network_error' }
  }
  return phase === 'request'
    ? { message: `Your FreeLLMAPI server is running, but this chat request's connection failed after ${after}, before any answer arrived (${browser}).`, code: 'connection_dropped' }
    : { message: `The connection dropped after ${after}, before the answer finished (${browser}). The server is still running.`, code: 'stream_interrupted' }
}

export async function streamChat(
  turns: ChatTurn[],
  opts: { conversationId?: number; provider?: string; signal?: AbortSignal } & StreamHandlers = {},
): Promise<ChatOutcome> {
  const outcome: ChatOutcome = { route: null, text: '', finishReason: null, latencyMs: null, error: null, aborted: false }
  const startedAt = Date.now()
  let res: Response
  try {
    res = await apiSend('POST', '/api/glixel/chat', {
      messages: turns,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      ...(opts.provider && opts.provider !== 'freellmapi' ? { provider: opts.provider } : {}),
    }, opts.signal)
  } catch (err) {
    if (opts.signal?.aborted) return { ...outcome, aborted: true }
    if (err instanceof ApiError) return { ...outcome, error: { message: err.message, code: null, status: err.status } }
    if (err instanceof RefusedWriteError) return { ...outcome, error: { message: `GLIXEL refused to send this request (${err.message}).`, code: 'client_refused', status: null } }
    const failure = await connectionFailure(err, startedAt, 'request')
    if (opts.signal?.aborted) return { ...outcome, aborted: true }
    return { ...outcome, error: { ...failure, status: null } }
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (res.ok && contentType.includes('text/html')) {
    // The request was answered by something serving web pages, not the API:
    // the same failure the dashboard's apiFetch reports (#257).
    return { ...outcome, error: { message: 'Got a web page instead of the chat API. /api is not reaching the FreeLLMAPI server at this address.', code: 'not_api', status: res.status } }
  }
  if (!contentType.includes('text/event-stream')) {
    let message = `The server answered ${res.status}.`
    let code: string | null = null
    try {
      const body = await res.json() as { error?: { message?: string; code?: string | null } }
      message = body.error?.message ?? message
      code = body.error?.code ?? null
    } catch { /* not JSON */ }
    return { ...outcome, error: { message, code, status: res.status } }
  }

  if (!res.body) return { ...outcome, error: { message: 'The server answered without a readable stream.', code: 'stream_incomplete', status: res.status } }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { events, rest } = parseSseChunk(buffer)
      buffer = rest
      for (const e of events) {
        if (e.type === 'route') {
          outcome.route = {
            platform: String(e.platform), model: String(e.model), displayName: String(e.displayName),
            fallbackAttempts: Number(e.fallbackAttempts ?? 0),
            fallbackTrail: typeof e.fallbackTrail === 'string' ? e.fallbackTrail : null,
          }
          opts.onRoute?.(outcome.route)
        } else if (e.type === 'delta' && typeof e.text === 'string') {
          outcome.text += e.text
          opts.onDelta?.(e.text)
        } else if (e.type === 'done') {
          finished = true
          outcome.finishReason = typeof e.finishReason === 'string' ? e.finishReason : null
          outcome.latencyMs = typeof e.latencyMs === 'number' ? e.latencyMs : null
        } else if (e.type === 'error') {
          finished = true
          outcome.error = { message: String(e.message ?? 'The provider failed mid-answer.'), code: typeof e.code === 'string' ? e.code : null, status: null }
        }
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) return { ...outcome, aborted: true }
    outcome.error = { ...(await connectionFailure(err, startedAt, 'stream')), status: null }
    return outcome
  }
  if (opts.signal?.aborted) return { ...outcome, aborted: true }
  if (!finished) outcome.error = { message: 'The answer ended unexpectedly.', code: 'stream_incomplete', status: null }
  return outcome
}

/** Plain-language guidance for the error codes the server returns. */
export function errorHint(code: string | null, status: number | null): string | null {
  switch (code) {
    case 'no_providers_configured': return 'No free provider is set up yet. Add a key on the dashboard\'s Keys page.'
    case 'free_only_blocked': return 'Free-only routing refused every configured provider. Add a key for a free provider, or opt one in on the server.'
    case 'rate_limit_exceeded':
    case 'routing_exhausted': return 'Every free model is busy or rate-limited right now. Try again shortly.'
    case 'provider_authentication_failed': return 'A provider rejected its key. Check it on the dashboard\'s Providers page.'
    case 'conversation_too_long': return 'This conversation is too long. Start a new one.'
    case 'network_error': return 'Check that the FreeLLMAPI server is still running in Termux, and that this page uses the same address and port.'
    case 'connection_dropped': return 'The server was reached but the connection closed while waiting. Retry; if it repeats, check the server log for this request.'
    case 'stream_interrupted': return 'Retry. If it repeats, check the server log for this request.'
    case 'not_api': return 'Open GLIXEL from the FreeLLMAPI server itself, e.g. http://localhost:<port>/glixel, not from a dev server or a copy of the files.'
    case 'client_refused': return 'This is a GLIXEL bug; please report it.'
    case 'provider_unavailable': return 'Switch the AI path back to FreeLLMAPI to keep chatting.'
    default: return status === 401 ? 'Your session has expired. Sign in on the dashboard again.' : null
  }
}
