import { describe, it, expect, vi } from 'vitest'
import { frameData, readChatStream, type ChatStreamHandlers } from './playground-stream'

/** A stream that hands out exactly these byte chunks, in order. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** One `data:` frame, framed the way the proxy writes it. */
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

/** A content delta chunk, shaped like the proxy's `mkChunk`. */
const contentFrame = (content: string) => frame({
  id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'llama-3.3-70b',
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
})

const collect = () => {
  const deltas: string[] = []
  const reasoning: string[] = []
  const errors: string[] = []
  const handlers: ChatStreamHandlers = {
    onDelta: t => deltas.push(t),
    onReasoning: t => reasoning.push(t),
    onError: m => errors.push(m),
  }
  return { deltas, reasoning, errors, handlers }
}

describe('frameData', () => {
  it('pulls the payload out of a single-line frame', () => {
    expect(frameData('data: {"a":1}')).toBe('{"a":1}')
  })

  it('joins the multiple data lines of one event, per the SSE spec', () => {
    expect(frameData('data: line one\ndata: line two')).toBe('line one\nline two')
  })

  it('ignores comment/keepalive lines and other SSE fields', () => {
    expect(frameData(': keepalive')).toBeNull()
    expect(frameData('event: message\nid: 7')).toBeNull()
    expect(frameData('event: message\ndata: {"a":1}')).toBe('{"a":1}')
  })
})

describe('readChatStream', () => {
  it('assembles content from several frames delivered in one read', async () => {
    const { deltas, handlers } = collect()
    const result = await readChatStream(
      streamOf(contentFrame('Hello') + contentFrame(', ') + contentFrame('world') + 'data: [DONE]\n\n'),
      handlers,
    )
    expect(result.content).toBe('Hello, world')
    expect(result.done).toBe(true)
    expect(deltas).toEqual(['Hello', ', ', 'world'])
  })

  it('reassembles a frame whose JSON is split across two reads', async () => {
    const whole = contentFrame('split me')
    const cut = Math.floor(whole.length / 2)
    const result = await readChatStream(
      streamOf(whole.slice(0, cut), whole.slice(cut) + 'data: [DONE]\n\n'),
    )
    expect(result.content).toBe('split me')
  })

  it('reassembles a frame split at every single byte offset', async () => {
    // The reader must never depend on where the network happened to cut.
    const whole = contentFrame('abc') + contentFrame('def') + 'data: [DONE]\n\n'
    for (let cut = 1; cut < whole.length; cut++) {
      const result = await readChatStream(streamOf(whole.slice(0, cut), whole.slice(cut)))
      expect(result.content).toBe('abcdef')
    }
  })

  it('accumulates reasoning_content separately from the answer', async () => {
    const { deltas, reasoning, handlers } = collect()
    const result = await readChatStream(streamOf(
      frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
      frame({ choices: [{ index: 0, delta: { reasoning_content: 'Let me ' }, finish_reason: null }] }),
      frame({ choices: [{ index: 0, delta: { reasoning_content: 'think.' }, finish_reason: null }] }),
      contentFrame('42'),
      'data: [DONE]\n\n',
    ), handlers)
    expect(result.reasoning).toBe('Let me think.')
    expect(result.content).toBe('42')
    expect(reasoning).toEqual(['Let me ', 'think.'])
    expect(deltas).toEqual(['42'])
  })

  it('also accepts the Ollama-style `reasoning` key', async () => {
    const result = await readChatStream(streamOf(
      frame({ choices: [{ index: 0, delta: { reasoning: 'hmm' }, finish_reason: null }] }),
    ))
    expect(result.reasoning).toBe('hmm')
  })

  it('takes the finish reason and the trailing choice-less usage frame', async () => {
    const result = await readChatStream(streamOf(
      contentFrame('done'),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      frame({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }),
      'data: [DONE]\n\n',
    ))
    expect(result.content).toBe('done')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({ prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 })
  })

  it('stops at [DONE] and ignores anything written after it', async () => {
    const { deltas, handlers } = collect()
    const result = await readChatStream(
      streamOf(contentFrame('kept') + 'data: [DONE]\n\n' + contentFrame('ignored')),
      handlers,
    )
    expect(result.content).toBe('kept')
    expect(result.done).toBe(true)
    expect(deltas).toEqual(['kept'])
  })

  it('surfaces an in-band stream_error frame', async () => {
    const { errors, handlers } = collect()
    const result = await readChatStream(streamOf(
      contentFrame('partial '),
      frame({ error: { message: 'Provider error (Groq): stream interrupted', type: 'stream_error' } }),
      'data: [DONE]\n\n',
    ), handlers)
    expect(result.error).toBe('Provider error (Groq): stream interrupted')
    expect(errors).toEqual(['Provider error (Groq): stream interrupted'])
    // Whatever already streamed is still there — the error explains the cut.
    expect(result.content).toBe('partial ')
    expect(result.done).toBe(true)
  })

  it('falls back to a generic message when the error frame has no message', async () => {
    const result = await readChatStream(streamOf(frame({ error: { type: 'stream_error' } })))
    expect(result.error).toBe('Stream error')
  })

  it('skips unparseable frames instead of throwing', async () => {
    const { errors, handlers } = collect()
    const result = await readChatStream(streamOf(
      contentFrame('one'),
      'data: {not json at all\n\n',
      'data: null\n\n',
      ': keepalive\n\n',
      'garbage without a data prefix\n\n',
      contentFrame(' two'),
      'data: [DONE]\n\n',
    ), handlers)
    expect(result.content).toBe('one two')
    expect(errors).toEqual([])
  })

  it('handles CRLF frame separators, including a CRLF split across reads', async () => {
    const crlf = (payload: unknown) => `data: ${JSON.stringify(payload)}\r\n\r\n`
    const first = crlf({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] })
    const result = await readChatStream(streamOf(
      // Cut the stream between the \r and the \n of the frame terminator.
      first.slice(0, -1),
      '\n' + crlf({ choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }] }) + 'data: [DONE]\r\n\r\n',
    ))
    expect(result.content).toBe('ab')
    expect(result.done).toBe(true)
  })

  it('resolves with what it got when the stream ends without [DONE]', async () => {
    const result = await readChatStream(streamOf(contentFrame('cut short')))
    expect(result.content).toBe('cut short')
    expect(result.done).toBe(false)
  })

  it('reads a last frame that never got its terminating blank line', async () => {
    const result = await readChatStream(streamOf(
      contentFrame('first'),
      'data: {"choices":[{"index":0,"delta":{"content":" last"},"finish_reason":null}]}',
    ))
    expect(result.content).toBe('first last')
    expect(result.done).toBe(false)
  })

  it('ignores tool_call deltas rather than rendering them', async () => {
    const { deltas, handlers } = collect()
    const result = await readChatStream(streamOf(
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] }, finish_reason: null }] }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ), handlers)
    expect(result.content).toBe('')
    expect(deltas).toEqual([])
    expect(result.finishReason).toBe('tool_calls')
  })

  it('survives an empty stream', async () => {
    const result = await readChatStream(streamOf())
    expect(result).toEqual({ content: '', reasoning: '', done: false })
  })

  it('calls onDone exactly once, with the assembled result', async () => {
    const onDone = vi.fn()
    const result = await readChatStream(
      streamOf(contentFrame('hi') + 'data: [DONE]\n\n'),
      { onDone },
    )
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith(result)
  })

  it('propagates a reader failure so the caller can show an error bubble', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(contentFrame('partial')))
        controller.error(new Error('network went away'))
      },
    })
    await expect(readChatStream(stream)).rejects.toThrow('network went away')
  })
})
