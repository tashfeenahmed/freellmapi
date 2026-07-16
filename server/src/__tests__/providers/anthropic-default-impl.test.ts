import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseProvider } from '../../providers/base.js';
import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk, Platform } from '@freellmapi/shared/types.js';
import type { MessagesOptions } from '@freellmapi/shared/anthropic-types.js';

/** Minimal concrete provider for testing the default messages/streamMessages implementations. */
class TestAnthropicAdapterProvider extends BaseProvider {
  readonly platform: Platform = 'groq';
  readonly name = 'TestAnthropicProvider';

  chatCompletionImpl = vi.fn<[string, ChatMessage[], string, any], Promise<ChatCompletionResponse>>();
  streamChatCompletionImpl = vi.fn<[string, ChatMessage[], string, any], AsyncGenerator<ChatCompletionChunk>>();
  validateKeyImpl = vi.fn<[string], Promise<boolean>>();

  async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: any): Promise<ChatCompletionResponse> {
    return this.chatCompletionImpl(apiKey, messages, modelId, options);
  }

  async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: any): AsyncGenerator<ChatCompletionChunk> {
    yield* this.streamChatCompletionImpl(apiKey, messages, modelId, options);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    return this.validateKeyImpl(apiKey);
  }
}

describe('BaseProvider messages (default Anthropic impl)', () => {
  let provider: TestAnthropicAdapterProvider;

  beforeEach(() => {
    provider = new TestAnthropicAdapterProvider();
  });

  const sampleOptions: MessagesOptions = {
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1024,
  };

  it('delegates to chatCompletion after adapting', async () => {
    provider.chatCompletionImpl.mockResolvedValue({
      id: 'chatcmpl-001',
      object: 'chat.completion',
      created: 1,
      model: 'delegated-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });

    const result = await provider.messages('key123', sampleOptions);

    expect(provider.chatCompletionImpl).toHaveBeenCalledTimes(1);
    const [apiKey, messages, model, opts] = provider.chatCompletionImpl.mock.calls[0];
    expect(apiKey).toBe('key123');
    expect(model).toBe('auto');
    expect(messages).toHaveLength(1);
    expect(opts).toHaveProperty('max_tokens', 1024);

    expect(result.type).toBe('message');
    expect(result.role).toBe('assistant');
    expect(result.content).toEqual([{ type: 'text', text: 'Hi!' }]);
    expect(result.stop_reason).toBe('end_turn');
  });

  it('delegates to streamChatCompletion for streaming', async () => {
    const chunks: ChatCompletionChunk[] = [
      { id: 'chatcmpl-001', object: 'chat.completion.chunk', created: 1, model: 'x', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'chatcmpl-001', object: 'chat.completion.chunk', created: 1, model: 'x', choices: [{ index: 0, delta: { content: 'Streaming' }, finish_reason: null }] },
      { id: 'chatcmpl-001', object: 'chat.completion.chunk', created: 1, model: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];

    async function* mockGen() { for (const c of chunks) yield c; }
    provider.streamChatCompletionImpl.mockReturnValue(mockGen());

    const events: any[] = [];
    for await (const e of provider.streamMessages('key456', sampleOptions)) {
      events.push(e);
    }

    expect(provider.streamChatCompletionImpl).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === 'message_start')).toBe(true);
    expect(events.some(e => e.type === 'content_block_delta')).toBe(true);
    expect(events.some(e => e.type === 'message_stop')).toBe(true);
  });
});
