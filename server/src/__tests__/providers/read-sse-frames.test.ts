import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { resetTimeoutWarnings } from '../../lib/provider-timeout.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const CONTENT_CHUNK = '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}';
const FINISH_CHUNK = '{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}';

function makeProvider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    platform: 'groq',
    name: 'TestProvider',
    baseUrl: 'https://api.test.com/v1',
    timeoutMs: 5000,
  });
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

afterEach(() => {
  delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS;
  resetTimeoutWarnings();
  vi.restoreAllMocks();
});

describe('readSseFrames data: prefix (issue #1087)', () => {
  it('parses data: {json} with a space after the colon', async () => {
    const body = `data: ${CONTENT_CHUNK}\n\ndata: ${FINISH_CHUNK}\n\ndata: [DONE]\n\n`;
    const provider = makeProvider();
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(body));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
    expect(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
  });

  it('parses data:{json} with no space after the colon', async () => {
    const body = `data:${CONTENT_CHUNK}\n\ndata:${FINISH_CHUNK}\n\ndata:[DONE]\n\n`;
    const provider = makeProvider();
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(body));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
    expect(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
  });

  it('terminates on data:[DONE] with no space', async () => {
    const body = `data: ${CONTENT_CHUNK}\n\ndata:[DONE]\n\n`;
    const provider = makeProvider();
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(body));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
    expect(chunks).toHaveLength(1);
  });

  it('parses mixed space and no-space frames in one stream', async () => {
    const body = [
      `data: ${CONTENT_CHUNK}`,
      `data:${FINISH_CHUNK}`,
      'data: [DONE]',
    ].join('\n\n') + '\n\n';
    const provider = makeProvider();
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(body));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
    expect(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
  });

  it('ignores SSE comment lines like : keepalive', async () => {
    const body = `: keepalive\n\ndata: ${CONTENT_CHUNK}\n\n: ping\n\ndata: ${FINISH_CHUNK}\n\ndata: [DONE]\n\n`;
    const provider = makeProvider();
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(body));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
    expect(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
  });

  it('skips malformed data: lines and still parses later frames', async () => {
    const body = `data:\n\ndata: not-json\n\ndata: ${CONTENT_CHUNK}\n\ndata: ${FINISH_CHUNK}\n\ndata: [DONE]\n\n`;
    const provider = makeProvider();
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(body));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
    expect(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
  });

  it('throws when the stream ends without [DONE] or finish_reason', async () => {
    const body = `data: ${CONTENT_CHUNK}\n\n`;
    const provider = makeProvider();
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(body));

    const err = await collect(provider.streamChatCompletion('k', MESSAGES, 'm')).then(() => null, e => e);
    expect(err).not.toBeNull();
    expect(err.message).toContain('stream ended unexpectedly');
    expect(err.message).toContain('no [DONE], no finish_reason');
  });
});
