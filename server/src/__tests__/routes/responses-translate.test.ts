import { describe, it, expect } from 'vitest';
import {
  toChatMessages,
  toChatTools,
  toChatToolChoice,
  buildResponseObject,
  responsesInputRequestsComputerUse,
  responsesInputHasFileIdImage,
} from '../../routes/responses.js';

describe('Responses → chat translation (#96)', () => {
  it('maps a plain string input to a single user message', () => {
    expect(toChatMessages({ input: 'hello' } as any)).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  it('prepends instructions as a system message', () => {
    const msgs = toChatMessages({ instructions: 'You are terse.', input: 'hi' } as any);
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('drops Codex additional_tools metadata without creating an empty turn', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'additional_tools', id: 'at_1', role: 'developer', tools: [{ type: 'shell' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    } as any);
    expect(msgs).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('flattens message items with content parts and maps the developer role to system', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] },
      ],
    } as any);
    expect(msgs).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ab' },
    ]);
  });

  it('translates image parts into image_url content blocks (keeps all-text content a string)', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
        ] },
        { type: 'message', role: 'user', content: 'plain text stays a string' },
      ],
    } as any);
    expect(msgs[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ],
    });
    expect(msgs[1]).toEqual({ role: 'user', content: 'plain text stays a string' });
  });

  it('accepts chat-style image_url and computer_screenshot parts', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'user', content: [
          { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
        ] },
      ],
    } as any);
    expect(msgs[0]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
    });
  });

  it('preserves the Responses detail hint on image parts', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'user', content: [
          { type: 'input_image', image_url: 'https://example.com/x.png', detail: 'high' },
        ] },
      ],
    } as any);
    expect(msgs[0]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png', detail: 'high' } }],
    });
  });

  it('folds refusal parts into text so replayed assistant turns are not emptied', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'assistant', content: [
          { type: 'refusal', refusal: 'I cannot help with that.' },
        ] },
      ],
    } as any);
    expect(msgs[0]).toEqual({ role: 'assistant', content: 'I cannot help with that.' });
  });

  it('maps a function_call item to an assistant tool_call', () => {
    const msgs = toChatMessages({
      input: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' }],
    } as any);
    expect(msgs[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
    });
  });

  it('folds consecutive standalone function_call items into one assistant turn', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
        { type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{"tz":"PST"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
    } as any);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{"tz":"PST"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    ]);
  });

  it('maps a function_call_output item to a tool message', () => {
    const msgs = toChatMessages({
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'sunny' }],
    } as any);
    expect(msgs[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' });
  });

  it('merges an assistant message item with its following function_call items into one turn', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'assistant', content: 'Let me check.' },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
        { type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{}' },
      ],
    } as any);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
        ],
      },
    ]);
  });

  it('merges an empty assistant item with its following function_call items (content null)', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'assistant', content: [] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
      ],
    } as any);
    expect(msgs).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
      },
    ]);
  });

  it('drops empty assistant message items (no tool_calls)', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'assistant', content: [] },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    } as any);
    expect(msgs).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('hoists system/developer messages to the start of the conversation', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'message', role: 'developer', content: 'mid-conversation system' },
        { type: 'message', role: 'user', content: 'again' },
      ],
    } as any);
    expect(msgs).toEqual([
      { role: 'system', content: 'mid-conversation system' },
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('keeps instructions first, then hoisted system messages in order', () => {
    const msgs = toChatMessages({
      instructions: 'You are terse.',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'message', role: 'developer', content: 'rule 2' },
        { type: 'message', role: 'developer', content: 'rule 3' },
      ],
    } as any);
    expect(msgs).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'system', content: 'rule 2' },
      { role: 'system', content: 'rule 3' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('skips computer_call / computer_call_output / reasoning / local_shell_call input items', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'computer_call', call_id: 'cc_1', action: { type: 'click', coordinate: [1, 2] } },
        { type: 'computer_call_output', call_id: 'cc_1', output: [{ type: 'computer_screenshot', image_url: 'data:image/png;base64,AA==' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
        { type: 'local_shell_call', call_id: 'ls_1', action: { type: 'bash', command: 'ls' } },
        { type: 'message', role: 'user', content: 'what now?' },
      ],
    } as any);
    expect(msgs).toEqual([{ role: 'user', content: 'what now?' }]);
  });

  it('detects computer-use requests from tools and computer_call items', () => {
    expect(responsesInputRequestsComputerUse({ tools: [{ type: 'computer' }] } as any)).toBe(true);
    expect(responsesInputRequestsComputerUse({ tools: [{ type: 'computer_use_preview' }] } as any)).toBe(true);
    expect(responsesInputRequestsComputerUse({ tools: [{ type: 'function', name: 'f' }] } as any)).toBe(false);
    expect(responsesInputRequestsComputerUse({
      input: [{ type: 'computer_call', call_id: 'cc_1', action: { type: 'click' } }],
    } as any)).toBe(true);
    expect(responsesInputRequestsComputerUse({ input: 'plain text' } as any)).toBe(false);
  });

  it('flags unresolvable input_image parts (file_id-only, missing or empty url)', () => {
    expect(responsesInputHasFileIdImage({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_abc' }] }],
    } as any)).toBe(true);
    // No url at all — the lenient schema lets this through validation, so the
    // pre-check is the only thing standing between it and a blind answer.
    expect(responsesInputHasFileIdImage({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image' }] }],
    } as any)).toBe(true);
    expect(responsesInputHasFileIdImage({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: '' }] }],
    } as any)).toBe(true);
    // A resolvable image_url alongside the file_id is fine.
    expect(responsesInputHasFileIdImage({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_abc', image_url: 'data:image/png;base64,AA==' }] }],
    } as any)).toBe(false);
    // Plain url images and string inputs never flag.
    expect(responsesInputHasFileIdImage({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/x.png' }] }],
    } as any)).toBe(false);
    expect(responsesInputHasFileIdImage({ input: 'plain text' } as any)).toBe(false);
  });

  it('converts flat Responses tools to nested chat tools', () => {
    const tools = toChatTools([
      { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: true },
    ] as any);
    expect(tools).toEqual([
      { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' }, strict: true } },
    ]);
  });

  it('converts tool_choice forms', () => {
    expect(toChatToolChoice('auto' as any)).toBe('auto');
    expect(toChatToolChoice({ type: 'function', name: 'f' } as any)).toEqual({ type: 'function', function: { name: 'f' } });
    expect(toChatToolChoice(undefined)).toBeUndefined();
  });
});

describe('chat result → Responses object (#96)', () => {
  it('builds a message output item plus usage for text', () => {
    const r = buildResponseObject({ id: 'resp_x', model: 'm', text: 'hi there', toolCalls: [], promptTokens: 5, completionTokens: 2 });
    expect(r.object).toBe('response');
    expect(r.status).toBe('completed');
    expect(r.output_text).toBe('hi there');
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] });
    expect(r.usage).toMatchObject({ input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  });

  it('emits function_call output items for tool calls', () => {
    const r = buildResponseObject({
      id: 'resp_x', model: 'm', text: '',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      promptTokens: 1, completionTokens: 1,
    });
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' });
  });
});
