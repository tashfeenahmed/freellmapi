import { describe, it, expect } from 'vitest';
import { openAIChunksToAnthropicEvents } from '../../lib/anthropic-stream.js';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

/** Helper: create a simple OpenAI-style SSE chunk */
function chunk(overrides: Record<string, unknown> = {}): ChatCompletionChunk {
  return {
    id: 'chatcmpl-001',
    object: 'chat.completion.chunk',
    created: 1234567890,
    model: 'test-model',
    choices: [{
      index: 0,
      delta: {},
      finish_reason: null,
    }],
    ...overrides,
  } as ChatCompletionChunk;
}

/** Helper: collect all events from the generator */
async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

async function* toGenerator(chunks: ChatCompletionChunk[]): AsyncGenerator<ChatCompletionChunk> {
  for (const c of chunks) yield c;
}

describe('openAIChunksToAnthropicEvents', () => {
  it('emits complete text lifecycle: message_start → content_block_start → delta → content_block_stop → message_delta → message_stop', async () => {
    const gen = openAIChunksToAnthropicEvents(
      toGenerator([
        chunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ]),
      'test-model',
      10,
    );

    const events = await collect(gen);

    // message_start
    expect(events[0].type).toBe('message_start');
    expect(events[0].message.model).toBe('test-model');
    expect(events[0].message.usage.input_tokens).toBe(10);

    // content_block_start (text)
    expect(events[1].type).toBe('content_block_start');
    expect(events[1].content_block.type).toBe('text');

    // content_block_delta (text)
    expect(events[2].type).toBe('content_block_delta');
    expect(events[2].delta.type).toBe('text_delta');
    expect(events[2].delta.text).toBe('Hello');

    expect(events[3].type).toBe('content_block_delta');
    expect(events[3].delta.text).toBe(' world');

    // content_block_stop
    expect(events[4].type).toBe('content_block_stop');

    // message_delta
    expect(events[5].type).toBe('message_delta');
    expect(events[5].delta.stop_reason).toBe('end_turn');

    // message_stop
    expect(events[6].type).toBe('message_stop');

    expect(events).toHaveLength(7);
  });

  it('handles tool_calls and emits tool_use blocks', async () => {
    const gen = openAIChunksToAnthropicEvents(
      toGenerator([
        chunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { content: 'Let me check' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather' } }] }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"NYC"}' } }] }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      ]),
      'test-model',
      10,
    );

    const events = await collect(gen);

    // Text block should be closed before tool_use
    const stopEvents = events.filter(e => e.type === 'content_block_stop');
    expect(stopEvents).toHaveLength(2); // text stop + tool_use stop

    // Tool use block
    const toolStart = events.find(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
    expect(toolStart).toBeDefined();
    expect(toolStart.content_block.name).toBe('get_weather');

    // message_delta has stop_reason tool_use
    const msgDelta = events.find(e => e.type === 'message_delta');
    expect(msgDelta.delta.stop_reason).toBe('tool_use');
  });

  it('handles multiple tool_calls in same turn', async () => {
    const gen = openAIChunksToAnthropicEvents(
      toGenerator([
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'tool_a' }, arguments: '' }] }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }, { index: 1, id: 'call_2', function: { name: 'tool_b' }, arguments: '{}' }] }, finish_reason: 'tool_calls' }] }),
      ]),
      'test-model',
      10,
    );

    const events = await collect(gen);

    const toolStarts = events.filter(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
    expect(toolStarts).toHaveLength(2);

    const toolStops = events.filter(e => e.type === 'content_block_stop');
    expect(toolStops).toHaveLength(2);
  });

  it('throws on empty completion (no text, no tool calls)', async () => {
    const gen = openAIChunksToAnthropicEvents(
      toGenerator([
        chunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ]),
      'test-model',
      10,
    );

    await expect(collect(gen)).rejects.toThrow('empty completion');
  });

  it('throws on in-band error before message_start', async () => {
    const gen = openAIChunksToAnthropicEvents(
      toGenerator([
        { error: { message: 'upstream error' } } as any,
      ]),
      'test-model',
      10,
    );

    await expect(collect(gen)).rejects.toThrow('in-band provider error');
  });

  it('uses provided model name when stream does not carry model', async () => {
    const gen = openAIChunksToAnthropicEvents(
      toGenerator([
        chunk({ choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ]),
      'provided-model',
      5,
    );

    const events = await collect(gen);
    expect(events[0].message.model).toBe('test-model');
  });
});
