import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from '../../providers/index.js';

const completion = {
  id: 'chatcmpl-radeon',
  object: 'chat.completion',
  created: 1,
  model: 'Qwen3.8-Flash-Next',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe('AMD Radeon Cloud provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the documented endpoint, bearer auth, safe knobs, and one tool call at a time', async () => {
    const provider = getProvider('radeon');
    expect(provider).toBeDefined();

    let url = '';
    let init: RequestInit | undefined;
    vi.spyOn(global, 'fetch').mockImplementation(async (input, requestInit) => {
      url = String(input);
      init = requestInit;
      return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await provider!.chatCompletion(
      'rc-' + 'a'.repeat(48),
      [{ role: 'user', content: 'hi' }],
      'Qwen3.8-Flash-Next',
      {
        tools: [{
          type: 'function',
          function: { name: 'lookup', description: 'look up a value', parameters: { type: 'object', properties: {} } },
        }],
        parallel_tool_calls: true,
        reasoning_effort: 'high',
        top_k: 40,
      },
    );

    expect(url).toBe('https://developer.amd.com.cn/radeon/api/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer rc-/);
    const body = JSON.parse(String(init?.body));
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning_effort).toBe('medium');
    expect(body).not.toHaveProperty('top_k');
  });

  it('validates credentials against the authenticated models endpoint', async () => {
    const provider = getProvider('radeon');
    let url = '';
    let init: RequestInit | undefined;
    vi.spyOn(global, 'fetch').mockImplementation(async (input, requestInit) => {
      url = String(input);
      init = requestInit;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(provider!.validateKey('rc-' + 'b'.repeat(48))).resolves.toBe(true);
    expect(url).toBe('https://developer.amd.com.cn/radeon/api/v1/models');
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer rc-/);
  });

  it('coalesces Qwen system instructions into one leading message', async () => {
    const provider = getProvider('radeon');
    let body: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await provider!.chatCompletion(
      'rc-' + 'c'.repeat(48),
      [
        { role: 'user', content: 'question' },
        { role: 'system', content: 'client instruction' },
        { role: 'system', content: 'profile instruction' },
      ],
      'Qwen3.8-Flash-Next',
    );

    expect(body.messages).toEqual([
      { role: 'system', content: 'client instruction\n\nprofile instruction' },
      { role: 'user', content: 'question' },
    ]);
  });
});
