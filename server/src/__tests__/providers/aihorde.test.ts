import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIHordeProvider } from '../../providers/aihorde.js';

// AI Horde's OpenAI proxy diverges from the OpenAI contract; these tests pin the
// AIHordeProvider normalizations that keep it from 422-ing or recording zero
// usage. See issue #345.
describe('AIHordeProvider', () => {
  let provider: AIHordeProvider;

  beforeEach(() => {
    provider = new AIHordeProvider();
  });

  /** Mock the upstream proxy: capture the outgoing request, return an
   * OpenAI-shaped body with AI Horde's kudos-only usage. */
  function mockProxy(content = 'PONG') {
    const captured: { url: string; init: any; body: any } = { url: '', init: null, body: null };
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url, init) => {
      captured.url = String(url);
      captured.init = init;
      captured.body = JSON.parse((init as any).body);
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'horde-1',
          object: 'chat.completion',
          created: 111,
          model: 'aphrodite/TheDrummer/Skyfall-31B-v4.2',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { kudos: 2 }, // AI Horde returns kudos, not token counts
        }),
        headers: { get: () => null },
      } as any;
    });
    return captured;
  }

  it('has correct platform/name and is keyless', () => {
    expect(provider.platform).toBe('aihorde');
    expect(provider.name).toBe('AI Horde');
    expect(provider.keyless).toBe(true);
  });

  it('floors max_tokens to 16 and wraps a string stop in an array', async () => {
    const cap = mockProxy();
    await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'm', {
      max_tokens: 4,
      stop: 'END',
    });
    expect(cap.body.max_tokens).toBe(16);
    expect(cap.body.stop).toEqual(['END']);
  });

  it('defaults max_tokens when the caller omits it', async () => {
    const cap = mockProxy();
    await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'm');
    expect(cap.body.max_tokens).toBeGreaterThanOrEqual(16);
  });

  it('passes an array stop through unchanged', async () => {
    const cap = mockProxy();
    await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'm', {
      stop: ['A', 'B'],
    });
    expect(cap.body.stop).toEqual(['A', 'B']);
  });

  it('drops tools/tool_choice/parallel_tool_calls (no tool support)', async () => {
    const cap = mockProxy();
    await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'm', {
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });
    expect(cap.body.tools).toBeUndefined();
    expect(cap.body.tool_choice).toBeUndefined();
    expect(cap.body.parallel_tool_calls).toBeUndefined();
  });

  it('maps the keyless sentinel to the anonymous key, and forwards a real key', async () => {
    const anon = mockProxy();
    await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'm');
    expect(anon.init.headers.Authorization).toBe('Bearer 0000000000');

    const real = mockProxy();
    await provider.chatCompletion('MY-REAL-HORDE-KEY', [{ role: 'user', content: 'hi' }], 'm');
    expect(real.init.headers.Authorization).toBe('Bearer MY-REAL-HORDE-KEY');
  });

  it('synthesizes token usage when the proxy returns kudos', async () => {
    mockProxy('PONG'); // 4 chars -> ceil(4/4)=1 completion token
    const result = await provider.chatCompletion(
      'no-key',
      [{ role: 'user', content: 'Reply with exactly one word: PONG' }], // 33 chars -> 9
      'm',
    );
    expect(result.usage.prompt_tokens).toBe(9);
    expect(result.usage.completion_tokens).toBe(1);
    expect(result.usage.total_tokens).toBe(10);
    expect((result.usage as any).kudos).toBeUndefined();
    expect(result._routed_via?.platform).toBe('aihorde');
  });

  it('streams the queued generation as a single content delta', async () => {
    mockProxy('hello world');
    const chunks: string[] = [];
    let finish: string | null = null;
    for await (const c of provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'm')) {
      if (c.choices[0].delta.content) chunks.push(c.choices[0].delta.content);
      if (c.choices[0].finish_reason) finish = c.choices[0].finish_reason;
    }
    expect(chunks.join('')).toBe('hello world');
    expect(finish).toBe('stop');
  });

  it('surfaces AI Horde\'s {detail} error shape', async () => {
    vi.spyOn(global, 'fetch').mockImplementationOnce(async () => ({
      ok: false,
      status: 406,
      statusText: 'Not Acceptable',
      json: () => Promise.resolve({ detail: 'Error: No user matching sent API Key.' }),
      headers: { get: () => null },
    } as any));
    await expect(
      provider.chatCompletion('bad', [{ role: 'user', content: 'hi' }], 'm'),
    ).rejects.toThrow('No user matching sent API Key');
  });
});
