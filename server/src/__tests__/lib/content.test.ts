import { describe, it, expect } from 'vitest';
import { contentToString, flattenMessageContent, messageHasImage } from '../../lib/content.js';

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
