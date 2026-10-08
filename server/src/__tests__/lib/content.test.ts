import { describe, it, expect } from 'vitest';
import { GITHUB_MAX_INPUT_TOKENS, contentToString, estimateInputTokens, flattenMessageContent, messageHasImage, normalizeOutboundContent, sanitizeResponse, stripImagesFromMessages, truncateMessagesForGithub } from '../../lib/content.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

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

describe('stripImagesFromMessages', () => {
  it('drops image blocks but keeps text blocks', () => {
    const out = stripImagesFromMessages([
      { role: 'user', content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ] },
    ]);
    expect(out[0].content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('replaces an image-only message with an empty string', () => {
    const out = stripImagesFromMessages([
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ] },
    ]);
    expect(out[0].content).toBe('');
  });

  it('leaves string content and plain messages untouched', () => {
    const m1 = { role: 'user', content: 'plain text' };
    const m2 = { role: 'assistant', content: null };
    const out = stripImagesFromMessages([m1 as any, m2 as any]);
    expect(out[0]).toBe(m1);  // identity preserved (no unnecessary copy)
    expect(out[1]).toBe(m2);
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

describe('truncateMessagesForGithub', () => {
  const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });
  // ~4000 tokens each under the chars/4 estimate the gateway uses everywhere.
  const big = (c: string) => c.repeat(16000);

  it('returns the same array when the request already fits', () => {
    const messages = [msg('system', 'be brief'), msg('user', 'hi')];
    expect(truncateMessagesForGithub(messages)).toBe(messages);
  });

  it('leaves an empty list alone', () => {
    const messages: ChatMessage[] = [];
    expect(truncateMessagesForGithub(messages)).toBe(messages);
  });

  it('drops the oldest turns, keeping the system prompt and the newest context', () => {
    const messages = [
      msg('system', 'be brief'),
      msg('user', big('a')),
      msg('assistant', big('b')),
      msg('user', big('c')),
      msg('user', 'the actual question'),
    ];
    const out = truncateMessagesForGithub(messages);
    expect(out).not.toBe(messages);
    expect(out[0]).toBe(messages[0]);
    expect(out[out.length - 1].content).toBe('the actual question');
    // Only one of the ~4000-token turns fits alongside the newest question.
    expect(out.map(m => m.content)).not.toContain(big('a'));
    expect(out.map(m => m.content)).toContain(big('c'));
    const total = out.reduce((sum, m) => sum + Math.ceil(String(m.content).length / 4), 0);
    expect(total).toBeLessThanOrEqual(GITHUB_MAX_INPUT_TOKENS);
  });

  it('keeps the system prompt verbatim wherever it sits in the list', () => {
    const system = msg('system', 'be brief');
    const messages = [msg('user', big('a')), system, msg('user', big('b'))];
    const out = truncateMessagesForGithub(messages);
    expect(out[0]).toBe(system);
  });

  it('truncates a single oversized message instead of sending nothing', () => {
    const out = truncateMessagesForGithub([msg('user', big('y').repeat(3))]);
    expect(out).toHaveLength(1);
    expect(String(out[0].content).length).toBe(GITHUB_MAX_INPUT_TOKENS * 4);
  });

  it('reserves the system prompt budget when truncating the newest message', () => {
    const system = msg('system', 'x'.repeat(400)); // 100 tokens
    const out = truncateMessagesForGithub([system, msg('user', big('z').repeat(3))]);
    expect(out[0]).toBe(system);
    expect(String(out[1].content).length).toBe((GITHUB_MAX_INPUT_TOKENS - 100) * 4);
  });

  it('honours a caller-supplied budget', () => {
    const messages = [msg('user', 'one'), msg('user', 'two'), msg('user', 'the newest')];
    const out = truncateMessagesForGithub(messages, 3); // 12 chars of room
    expect(out.map(m => m.content)).toEqual(['the newest']);
  });

  it('never rewrites multimodal content, only drops whole messages', () => {
    const image: ChatMessage = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] } as ChatMessage;
    const out = truncateMessagesForGithub([msg('user', big('a')), image], 1);
    expect(out).toEqual([image]);
  });
});

describe('estimateInputTokens', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];

  it('counts message text at ~4 chars per token', () => {
    expect(estimateInputTokens(messages)).toBe(100);
  });

  it('counts the tool schemas the request carries', () => {
    // Claude Code ships ~65 KB of tool schemas next to a few KB of messages;
    // an estimate without them routed its turns to models they could not fit.
    const tools = [{ type: 'function', function: { name: 'Read', description: 'd'.repeat(4000), parameters: { type: 'object' } } }];
    const withTools = estimateInputTokens(messages, tools);
    expect(withTools).toBeGreaterThan(100 + 1000);
    expect(estimateInputTokens(messages, [])).toBe(100);
  });

  it('counts assistant tool-call arguments', () => {
    const withCall: ChatMessage[] = [...messages, {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Write', arguments: 'a'.repeat(795) } }],
    } as ChatMessage];
    expect(estimateInputTokens(withCall)).toBe(100 + 200);
  });
});
