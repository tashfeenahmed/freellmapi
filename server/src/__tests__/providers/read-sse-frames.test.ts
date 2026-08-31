import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { resetTimeoutWarnings } from '../../lib/provider-timeout.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

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
  it('parses frames with a space after data:', async () => {
    const content = 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n';
    const finish = 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const provider = makeProvider();
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(content + finish));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
    expect(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
  });

  it('parses frames with no space after data:', async () => {
    const content = 'data:{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n';
    const finish = 'data:{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata:[DONE]\n\n';
    const provider = makeProvider();
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(content + finish));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
    expect(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
  });
});
