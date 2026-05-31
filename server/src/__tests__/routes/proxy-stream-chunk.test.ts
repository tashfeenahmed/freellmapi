import { describe, it, expect } from 'vitest';
import { streamChunkText } from '../../routes/proxy.js';

// Regression for the mid-stream crash: a streaming chunk with no `choices`
// array (Groq and others emit usage/keepalive frames like this) used to throw
// "Cannot read properties of undefined (reading '0')" via `chunk.choices[0]`,
// aborting the SSE response after headers were already sent (so no fallback).
describe('streamChunkText', () => {
  it('extracts delta content from a normal chunk', () => {
    expect(streamChunkText({ choices: [{ delta: { content: 'hello' } }] })).toBe('hello');
  });

  it('returns "" for a usage/keepalive chunk that has no choices array', () => {
    expect(streamChunkText({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).toBe('');
    expect(streamChunkText({ x_groq: { usage: {} } })).toBe('');
  });

  it('returns "" for an empty choices array', () => {
    expect(streamChunkText({ choices: [] })).toBe('');
  });

  it('returns "" for a tool-call delta with no text content', () => {
    expect(streamChunkText({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] })).toBe('');
  });

  it('returns "" for null / undefined / malformed chunks', () => {
    expect(streamChunkText(null)).toBe('');
    expect(streamChunkText(undefined)).toBe('');
    expect(streamChunkText({})).toBe('');
    expect(streamChunkText({ choices: [{}] })).toBe('');
  });
});
