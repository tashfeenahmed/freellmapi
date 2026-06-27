import { describe, it, expect } from 'vitest';
import { contentToString, flattenMessageContent, messageHasImage, normalizeOutboundContent, sanitizeResponse } from '../../lib/content.js';

describe('contentToString', () => {
  it('passes strings through', () => {
    expect(contentToString('hello')).toBe('hello');
    expect(contentToString('')).toBe('');
  });

  it('treats null and undefined as empty string', () => {
    expect(contentToString(null)).toBe('');
    expect(contentToString(undefined)).toBe('');
  });

  it('joins text blocks in OpenAI multimodal array envelope', () => {
    expect(contentToString([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ])).toBe('hello world');
  });

  it('drops non-text blocks (image_url etc.) — text-only providers flatten this way', () => {
    expect(contentToString([
      { type: 'text', text: 'describe ' },
      { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
      { type: 'text', text: 'this' },
    ])).toBe('describe this');
  });

  it('extracts Gemini-part-style { text } blocks with no type field (#200)', () => {
    expect(contentToString([{ text: 'hi' }, { text: ' there' }])).toBe('hi there');
    // a typed NON-text block still gets dropped even when it carries text
    expect(contentToString([{ type: 'reasoning', text: 'inner monologue' }, { type: 'text', text: 'ok' }])).toBe('ok');
  });

  it('handles an array of bare strings (some clients send this)', () => {
    expect(contentToString(['foo', 'bar'])).toBe('foobar');
  });

  it('returns empty string for unrecognized types instead of throwing', () => {
    expect(contentToString(42 as unknown)).toBe('');
    expect(contentToString({ unknown: true } as unknown)).toBe('');
  });
});

describe('flattenMessageContent', () => {
  it('converts every message content to a string', () => {
    const out = flattenMessageContent([
      { role: 'user', content: 'plain' },
      { role: 'user', content: [{ type: 'text', text: 'array' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ]);
    expect(out[0].content).toBe('plain');
    expect(out[1].content).toBe('array');
    expect(out[2].content).toBe('');
  });

  it('preserves other message fields (tool_calls, name, tool_call_id)', () => {
    const out = flattenMessageContent([
      { role: 'tool', content: 'result', tool_call_id: 'call-1', name: 'fn' },
    ]);
    expect(out[0]).toMatchObject({
      role: 'tool',
      content: 'result',
      tool_call_id: 'call-1',
      name: 'fn',
    });
  });
});

describe('messageHasImage', () => {
  it('detects image_url blocks (OpenAI vision envelope)', () => {
    expect(messageHasImage([
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ])).toBe(true);
  });

  it('detects a bare image block type', () => {
    expect(messageHasImage([
      { role: 'user', content: [{ type: 'image', source: 'x' } as any] },
    ])).toBe(true);
  });

  it('is false for string content and text-only arrays', () => {
    expect(messageHasImage([{ role: 'user', content: 'hello' }])).toBe(false);
    expect(messageHasImage([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])).toBe(false);
    expect(messageHasImage([{ role: 'assistant', content: null }])).toBe(false);
  });
});

describe('normalizeOutboundContent (#166)', () => {
  it('coerces array delta.content to a string on streaming chunks', () => {
    const chunk = { choices: [{ index: 0, delta: { content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] } }] };
    const out = normalizeOutboundContent(chunk);
    expect(out.choices[0].delta.content).toBe('hello');
  });

  it('coerces array message.content to a string on non-stream responses', () => {
    const result = { choices: [{ index: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'got it' }] } }] };
    const out = normalizeOutboundContent(result);
    expect(out.choices[0].message.content).toBe('got it');
  });

  it('preserves tool_calls even when text content is array-shaped', () => {
    const chunk = { choices: [{ delta: { content: [{ type: 'text', text: '' }], tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] };
    const out = normalizeOutboundContent(chunk);
    expect(out.choices[0].delta.content).toBe('');
    expect(out.choices[0].delta.tool_calls[0].id).toBe('c1');
  });

  it('leaves string content untouched', () => {
    const chunk = { choices: [{ delta: { content: 'already a string' } }] };
    expect(normalizeOutboundContent(chunk).choices[0].delta.content).toBe('already a string');
  });

  it('tolerates chunks with no choices array (usage/keepalive frames)', () => {
    expect(() => normalizeOutboundContent({ usage: { prompt_tokens: 1 } })).not.toThrow();
    expect(() => normalizeOutboundContent(null as unknown)).not.toThrow();
    expect(() => normalizeOutboundContent({} as unknown)).not.toThrow();
  });
});

describe('sanitizeResponse', () => {
  it('defaults a missing choice finish_reason to null', () => {
    const result = { choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }] };
    const out = sanitizeResponse(result) as any;
    expect(out.choices[0].finish_reason).toBeNull();
  });

  it('leaves an existing finish_reason untouched', () => {
    const result = { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }] };
    expect((sanitizeResponse(result) as any).choices[0].finish_reason).toBe('stop');
  });

  it('deletes a literal tool_calls: null on message and delta (the #200 mirror)', () => {
    const nonStream = { choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: null } }] };
    const out1 = sanitizeResponse(nonStream) as any;
    expect('tool_calls' in out1.choices[0].message).toBe(false);

    const stream = { choices: [{ delta: { content: 'hi', tool_calls: null } }] };
    const out2 = sanitizeResponse(stream) as any;
    expect('tool_calls' in out2.choices[0].delta).toBe(false);
  });

  it('preserves a real tool_calls array', () => {
    const result = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] } }] };
    const out = sanitizeResponse(result) as any;
    expect(out.choices[0].message.tool_calls).toHaveLength(1);
    expect(out.choices[0].message.tool_calls[0].id).toBe('c1');
  });

  it('coerces a non-string model to a string', () => {
    expect((sanitizeResponse({ model: 123, choices: [] }) as any).model).toBe('123');
    expect((sanitizeResponse({ model: 'gpt', choices: [] }) as any).model).toBe('gpt');
    expect((sanitizeResponse({ choices: [] }) as any).model).toBeUndefined();
  });

  it('does not touch content or reasoning_content', () => {
    const result = { choices: [{ message: { role: 'assistant', content: 'answer', reasoning_content: 'thinking' } }] };
    const out = sanitizeResponse(result) as any;
    expect(out.choices[0].message.content).toBe('answer');
    expect(out.choices[0].message.reasoning_content).toBe('thinking');
  });

  it('tolerates frames with no choices / non-objects', () => {
    expect(() => sanitizeResponse({ usage: { prompt_tokens: 1 } })).not.toThrow();
    expect(() => sanitizeResponse(null as unknown)).not.toThrow();
    expect(() => sanitizeResponse({} as unknown)).not.toThrow();
  });
});
