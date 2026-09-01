import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { classifyClientAgent } from '../../lib/client-classifier.js';

function request(path: string, headers: Record<string, string> = {}): Request {
  return {
    originalUrl: path,
    headers,
  } as unknown as Request;
}

describe('client agent classification', () => {
  it('prefers distinctive headers and protocol paths', () => {
    expect(classifyClientAgent(request('/v1/messages', {
      'x-claude-code-session-id': 'session',
    }))).toBe('claude-code');
    expect(classifyClientAgent(request('/v1/responses'))).toBe('codex');
    expect(classifyClientAgent(request('/v1beta/models/x:generateContent'))).toBe('gemini-cli');
    expect(classifyClientAgent(request('/api/chat'))).toBe('ollama-client');
    expect(classifyClientAgent(request('/v1/t/revocable/responses'))).toBe('codex');
    expect(classifyClientAgent(request('/v1/t/revocable/api/chat'))).toBe('ollama-client');
  });

  it('recognizes common coding-agent user agents', () => {
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'opencode/1.2.3',
    }))).toBe('opencode');
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'aider/0.80',
    }))).toBe('aider');
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'Kilo-Code/4.2',
    }))).toBe('kilo-code');
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'crush/0.8',
    }))).toBe('crush');
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'deepseek-harness/0.3.1 (+https://github.com/deepseek-ai/deepseek-harness)',
    }))).toBe('deepseek-harness');
  });

  it('separates MiMo Code from the OpenCode it derives from', () => {
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'mimo/0.4.0',
    }))).toBe('mimo-code');
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'MiMo-Code/0.4.0 (opencode)',
    }))).toBe('mimo-code');
    expect(classifyClientAgent(request('/v1/chat/completions', {
      'user-agent': 'opencode/1.2.3',
    }))).toBe('opencode');
  });

  it('recognizes Claude Code by its real claude-cli user agent', () => {
    expect(classifyClientAgent(request('/v1/messages', {
      'user-agent': 'claude-cli/1.0.62 (external, cli)',
    }))).toBe('claude-code');
    expect(classifyClientAgent(request('/v1/messages', {
      'x-session-id': 'affinity',
    }))).toBe('claude-code');
    expect(classifyClientAgent(request('/v1/messages'))).toBe('anthropic-sdk');
  });

  it('lets user agents beat wire-format fallbacks', () => {
    // Qwen Code speaks the Gemini wire; it must not count as gemini-cli.
    expect(classifyClientAgent(request('/v1beta/models/x:generateContent', {
      'user-agent': 'QwenCode/0.5 qwen-code',
    }))).toBe('qwen-code');
    // A plain openai SDK on /v1/responses is not Codex.
    expect(classifyClientAgent(request('/v1/responses', {
      'user-agent': 'OpenAI/NodeJS/4.52.0',
    }))).toBe('openai-sdk');
  });
});
