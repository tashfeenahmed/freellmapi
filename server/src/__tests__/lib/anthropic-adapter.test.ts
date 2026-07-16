import { describe, it, expect } from 'vitest';
import {
  anthropicToOpenAI,
  openAIToAnthropicResponse,
  anthropicContentToString,
  anthropicHasImage,
  estimateAnthropicTokens,
} from '../../lib/anthropic-adapter.js';
import type { MessagesOptions } from '@freellmapi/shared/anthropic-types.js';
import type { ChatCompletionResponse } from '@freellmapi/shared/types.js';

describe('anthropicToOpenAI', () => {
  const baseOptions: MessagesOptions = {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1024,
  };

  it('converts simple text user message', () => {
    const result = anthropicToOpenAI(baseOptions);
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('converts system string to system message at head', () => {
    const result = anthropicToOpenAI({ ...baseOptions, system: 'Be helpful' });
    expect(result.messages[0]).toEqual({ role: 'system', content: 'Be helpful' });
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('converts system as TextBlockParam[] to joined system message', () => {
    const result = anthropicToOpenAI({
      ...baseOptions,
      system: [{ type: 'text', text: 'Part A' }, { type: 'text', text: 'Part B' }],
    });
    expect(result.messages[0]).toEqual({ role: 'system', content: 'Part A\n\nPart B' });
  });

  it('handles string content on assistant message', () => {
    const result = anthropicToOpenAI({
      model: 'x',
      messages: [{ role: 'assistant', content: 'Sure!' }],
      max_tokens: 100,
    });
    expect(result.messages[0]).toEqual({ role: 'assistant', content: 'Sure!' });
  });

  it('converts user text content block array to string content', () => {
    const result = anthropicToOpenAI({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }] }],
      max_tokens: 100,
    });
    expect(result.messages[0].content).toBe('Hello world');
  });

  it('converts image content block to OpenAI image_url format', () => {
    const result = anthropicToOpenAI({
      model: 'x',
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }],
      }],
      max_tokens: 100,
    });
    const content = result.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as any[])[0].type).toBe('image_url');
    expect((content as any[])[0].image_url.url).toContain('image/png');
  });

  it('converts tool_use to OpenAI tool_calls format', () => {
    const result = anthropicToOpenAI({
      model: 'x',
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'NYC' } }],
      }],
      max_tokens: 100,
    });
    const msg = result.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0].id).toBe('toolu_01');
    expect(msg.tool_calls![0].function.name).toBe('get_weather');
    expect(JSON.parse(msg.tool_calls![0].function.arguments)).toEqual({ city: 'NYC' });
  });

  it('converts tool_result to tool role message', () => {
    const result = anthropicToOpenAI({
      model: 'x',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'Sunny' }],
      }],
      max_tokens: 100,
    });
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].tool_call_id).toBe('toolu_01');
    expect(result.messages[0].content).toBe('Sunny');
  });

  it('handles multi-turn conversation with mixed content types', () => {
    const result = anthropicToOpenAI({
      model: 'x',
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 72°F' }] },
      ],
      max_tokens: 100,
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'What is the weather?' });
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].content).toBe('Let me check.');
    expect(result.messages[1].tool_calls).toHaveLength(1);
    expect(result.messages[2].role).toBe('tool');
    expect(result.messages[2].content).toBe('Sunny, 72°F');
  });

  it('converts Anthropic tools to OpenAI function format', () => {
    const result = anthropicToOpenAI({
      ...baseOptions,
      tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].type).toBe('function');
    expect(result.tools![0].function.name).toBe('get_weather');
    expect(result.tools![0].function.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
  });

  it('maps tool_choice auto → string auto', () => {
    const result = anthropicToOpenAI({ ...baseOptions, tool_choice: { type: 'auto' } });
    expect(result.tool_choice).toBe('auto');
  });

  it('maps tool_choice any → required', () => {
    const result = anthropicToOpenAI({ ...baseOptions, tool_choice: { type: 'any' } });
    expect(result.tool_choice).toBe('required');
  });

  it('maps tool_choice tool → function choice', () => {
    const result = anthropicToOpenAI({ ...baseOptions, tool_choice: { type: 'tool', name: 'get_weather' } });
    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('maps tool_choice none → string none', () => {
    const result = anthropicToOpenAI({ ...baseOptions, tool_choice: { type: 'none' } });
    expect(result.tool_choice).toBe('none');
  });

  it('passes through temperature, max_tokens, top_p', () => {
    const result = anthropicToOpenAI({ ...baseOptions, temperature: 0.7, top_p: 0.9 });
    expect(result.temperature).toBe(0.7);
    expect(result.max_tokens).toBe(1024);
    expect(result.top_p).toBe(0.9);
  });
});

describe('openAIToAnthropicResponse', () => {
  const baseOpenAIResponse: ChatCompletionResponse = {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1234567890,
    model: 'gpt-4',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Hello! How can I help?' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it('converts text response to Anthropic message', () => {
    const result = openAIToAnthropicResponse(baseOpenAIResponse, 'my-model');
    expect(result.type).toBe('message');
    expect(result.role).toBe('assistant');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello! How can I help?' }]);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.model).toBe('my-model');
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });

  it('maps stop → end_turn', () => {
    const result = openAIToAnthropicResponse(baseOpenAIResponse, 'x');
    expect(result.stop_reason).toBe('end_turn');
  });

  it('maps tool_calls → tool_use', () => {
    const res: ChatCompletionResponse = {
      ...baseOpenAIResponse,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const result = openAIToAnthropicResponse(res, 'x');
    expect(result.stop_reason).toBe('tool_use');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } });
  });

  it('maps length → max_tokens', () => {
    const res: ChatCompletionResponse = {
      ...baseOpenAIResponse,
      choices: [{ ...baseOpenAIResponse.choices[0], finish_reason: 'length' }],
    };
    const result = openAIToAnthropicResponse(res, 'x');
    expect(result.stop_reason).toBe('max_tokens');
  });

  it('produces empty text block when content is null and no tool calls', () => {
    const res: ChatCompletionResponse = {
      ...baseOpenAIResponse,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
    };
    const result = openAIToAnthropicResponse(res, 'x');
    expect(result.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('handles invalid tool call JSON gracefully', () => {
    const res: ChatCompletionResponse = {
      ...baseOpenAIResponse,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bad_tool', arguments: 'not json' } }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const result = openAIToAnthropicResponse(res, 'x');
    expect(result.content[0]).toHaveProperty('type', 'tool_use');
    expect(result.content[0]).toHaveProperty('id', 'call_1');
  });

  it('handles finish_reason null', () => {
    const res: ChatCompletionResponse = {
      ...baseOpenAIResponse,
      choices: [{ ...baseOpenAIResponse.choices[0], finish_reason: null }],
    };
    const result = openAIToAnthropicResponse(res, 'x');
    expect(result.stop_reason).toBeNull();
  });
});

describe('anthropicContentToString', () => {
  it('returns plain string as-is', () => {
    expect(anthropicContentToString('hello')).toBe('hello');
  });

  it('joins text blocks', () => {
    expect(anthropicContentToString([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a b');
  });
});

describe('anthropicHasImage', () => {
  it('returns false for no images', () => {
    expect(anthropicHasImage([{ role: 'user', content: 'hi' }])).toBe(false);
  });

  it('returns true when an image block is present', () => {
    expect(anthropicHasImage([{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }],
    }])).toBe(true);
  });
});

describe('estimateAnthropicTokens', () => {
  it('estimates ~4 chars per token', () => {
    const tokens = estimateAnthropicTokens([{ role: 'user', content: 'Hello world!' }]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10); // 12 chars / 4 = 3 tokens
  });
});
