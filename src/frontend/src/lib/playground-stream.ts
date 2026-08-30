// SSE reader for the Playground's non-fusion chat streams.
//
// Every Playground request now asks for `stream: true`, so the standard
// OpenAI chat-completion stream has to be assembled in the browser. The proxy
// frames it as `data: {...}` blocks separated by a blank line and terminated by
// `data: [DONE]`, but the details vary per provider: a role-only preamble
// frame, tool_call deltas we don't render, a finish chunk, and a trailing
// usage-only frame whose `choices` array is empty. Network reads also split
// frames at arbitrary byte offsets, so a frame can arrive half at a time.
//
// Kept as a pure function over a ReadableStream so all of that is unit-testable
// without a component or a live provider.

/** Token accounting from the trailing usage frame (shape passed through as-is). */
export interface ChatStreamUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface ChatStreamResult {
  /** Everything accumulated from `choices[0].delta.content`. */
  content: string
  /** Everything accumulated from `choices[0].delta.reasoning_content`. */
  reasoning: string
  /** The last non-null `choices[0].finish_reason`, when the stream sent one. */
  finishReason?: string
  /** Usage from the finish chunk or the trailing choice-less frame. */
  usage?: ChatStreamUsage
  /** Message from an in-band `{ error: {...} }` frame, if one arrived. */
  error?: string
  /** True when the stream ended with an explicit `data: [DONE]`. */
  done: boolean
}

export interface ChatStreamHandlers {
  /** A visible answer delta. Called once per frame that carries content. */
  onDelta?: (text: string) => void
  /** A reasoning/thinking delta, kept separate from the answer. */
  onReasoning?: (text: string) => void
  /** An in-band stream error. The stream may still send `[DONE]` after it. */
  onError?: (message: string) => void
  /** Called once, after the stream ends, with the assembled result. */
  onDone?: (result: ChatStreamResult) => void
}

interface ChunkChoice {
  delta?: {
    content?: unknown
    reasoning_content?: unknown
    reasoning?: unknown
    tool_calls?: unknown
  }
  finish_reason?: unknown
}

/**
 * Pull the payload out of one SSE event block. An event may carry several
 * `data:` lines (they concatenate with newlines, per the SSE spec); comment
 * lines (`: keepalive`) and any other field are ignored. Returns null when the
 * block has no data at all.
 */
export function frameData(frame: string): string | null {
  const parts: string[] = []
  for (const rawLine of frame.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    parts.push(line.slice(5).trim())
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * Read a chat-completion SSE stream to the end, reporting deltas as they land.
 *
 * Tolerant by design: unparseable frames are skipped rather than thrown,
 * choice-less frames (the trailing usage frame) are fine, and a stream that
 * simply ends without `[DONE]` still resolves with whatever it produced. Only
 * a reader failure — an aborted fetch, a dropped socket — rejects.
 */
export async function readChatStream(
  stream: ReadableStream<Uint8Array>,
  handlers: ChatStreamHandlers = {},
): Promise<ChatStreamResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const result: ChatStreamResult = { content: '', reasoning: '', done: false }
  let buffer = ''

  // Returns true once `[DONE]` says there is nothing left to read.
  const handleFrame = (frame: string): boolean => {
    const data = frameData(frame)
    if (data === null) return false
    if (data === '[DONE]') return true

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(data) as Record<string, unknown>
    } catch {
      // Garbage or a partial frame the server flushed: skip it, keep reading.
      return false
    }
    if (!obj || typeof obj !== 'object') return false

    const error = obj.error as { message?: unknown } | undefined
    if (error) {
      const message = typeof error.message === 'string' ? error.message : 'Stream error'
      result.error = message
      handlers.onError?.(message)
      return false
    }

    const usage = obj.usage as ChatStreamUsage | null | undefined
    if (usage && typeof usage === 'object') result.usage = usage

    // A usage-only frame carries `choices: []`, and some providers omit the
    // key entirely on keepalive frames — neither is an error.
    const choices = obj.choices as ChunkChoice[] | undefined
    if (!Array.isArray(choices) || choices.length === 0) return false
    const choice = choices[0]
    if (!choice || typeof choice !== 'object') return false

    if (typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason

    const delta = choice.delta
    if (!delta || typeof delta !== 'object') return false

    // delta.tool_calls is deliberately ignored: the Playground renders prose,
    // and a half-assembled tool call is not something to show mid-stream.
    const reasoning = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : ''
    if (reasoning) {
      result.reasoning += reasoning
      handlers.onReasoning?.(reasoning)
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      result.content += delta.content
      handlers.onDelta?.(delta.content)
    }
    return false
  }

  try {
    reading: for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Normalising the whole buffer (not just the new bytes) keeps a CRLF
      // that straddles two reads from looking like a blank-line boundary.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary === -1) break
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (handleFrame(frame)) {
          result.done = true
          break reading
        }
      }
    }

    if (!result.done) {
      // Streams that end without a trailing blank line (or without [DONE] at
      // all) still leave a usable frame in the buffer.
      buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n')
      for (const frame of buffer.split('\n\n')) {
        if (handleFrame(frame)) {
          result.done = true
          break
        }
      }
    }
  } finally {
    // Releases the socket when we stopped early at [DONE]; a no-op once the
    // stream is already exhausted or the fetch was aborted.
    try {
      await reader.cancel()
    } catch {
      // The stream is already errored or closed — nothing to clean up.
    }
  }

  handlers.onDone?.(result)
  return result
}
