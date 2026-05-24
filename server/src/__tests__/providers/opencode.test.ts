import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { getProvider } from '../../providers/index.js';

describe('OpenCode Zen provider', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    // Mirror the registration in providers/index.ts so the tests exercise
    // the real config (baseUrl, headers) without depending on registry order.
    provider = new OpenAICompatProvider({
      platform: 'opencode',
      name: 'OpenCode Zen',
      baseUrl: 'https://opencode.ai/zen/v1',
    });
  });

  it('is registered in the provider registry', () => {
    const registered = getProvider('opencode');
    expect(registered).toBeDefined();
    expect(registered?.platform).toBe('opencode');
    expect(registered?.name).toBe('OpenCode Zen');
  });

  it('hits the opencode.ai/zen/v1/chat/completions endpoint with a Bearer key', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-zen-1',
          object: 'chat.completion',
          created: 0,
          model: 'big-pickle',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'sk-zen-test',
      [{ role: 'user', content: 'ping' }],
      'big-pickle',
    );

    expect(capturedUrl).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer sk-zen-test');
    expect(capturedHeaders['Content-Type']).toBe('application/json');
    expect(capturedBody.model).toBe('big-pickle');
    expect(capturedBody.messages[0].content).toBe('ping');
    expect(result.choices[0].message.content).toBe('pong');
    expect(result._routed_via).toEqual({ platform: 'opencode', model: 'big-pickle' });
  });

  it('surfaces upstream 429 ("too many requests") so router.ts can cooldown the key', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: () => Promise.resolve({ error: { message: 'too many requests, please try again' } }),
    } as any);

    await expect(
      provider.chatCompletion('sk-zen', [{ role: 'user', content: 'hi' }], 'big-pickle'),
    ).rejects.toThrow(/OpenCode Zen API error 429/);
  });

  it('surfaces the "Free usage exceeded" daily-budget error verbatim', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: () => Promise.resolve({
        error: { message: 'Free usage exceeded, add credits https://opencode.ai/zen' },
      }),
    } as any);

    await expect(
      provider.chatCompletion('sk-zen', [{ role: 'user', content: 'hi' }], 'deepseek-v4-flash-free'),
    ).rejects.toThrow(/Free usage exceeded/);
  });
});
