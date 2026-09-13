import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider, hasProvider } from '../../providers/index.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const completion = (model: string) => ({ id: 'test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: '17' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } });
const stream = (model: string) => new Response(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model,
  choices: [{ index: 0, delta: { content: '17' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });

describe('CLōD, Speechify and BlazeAPI adapters', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['clod', 'https://api.clod.io/v1/models'],
    ['speechify', 'https://api.speechify.ai/v1/workspaces/current/entitlements'],
    ['blaze', 'https://api.blazeapi.org/paid/v1/usage'],
  ] as const)('%s validates on an authenticated, non-generating endpoint', async (platform, endpoint) => {
    expect(hasProvider(platform)).toBe(true);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [] }));
    await expect(getProvider(platform)!.validateKey('test-key')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(endpoint);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer test-key');
    fetch.mockResolvedValue(json({ error: 'Invalid key' }, 401));
    await expect(getProvider(platform)!.validateKey('test-key')).resolves.toMatchObject({ valid: false });
    fetch.mockResolvedValue(json({ error: 'Unavailable' }, 503));
    await expect(getProvider(platform)!.validateKey('test-key')).rejects.toThrow();
  });

  it.each([
    ['clod', 'Gemma 4 31B IT', 'google/gemma-4-31B-it', 'https://api.clod.io/v1'],
    ['clod', 'GPT OSS 120B', 'accounts/fireworks/models/gpt-oss-120b', 'https://api.clod.io/v1'],
    ['clod', 'GPT OSS 20B', 'OpenAI/gpt-oss-20B', 'https://api.clod.io/v1'],
    ['clod', 'Qwen 3.5 9B', 'Qwen/Qwen3.5-9B', 'https://api.clod.io/v1'],
    ['blaze', 'tok/deepseek-v4-pro', 'tok/deepseek-v4-pro', 'https://api.blazeapi.org/paid/v1'],
  ] as const)('%s sends exact requested IDs and accepts a matching upstream identity (%s)', async (platform, requested, returned, base) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(completion(returned)));
    const provider = getProvider(platform)!;
    const result = await provider.chatCompletion('test-key', [{ role: 'user', content: '8+9' }], requested, { max_tokens: 64, temperature: 0.2 });
    expect(result.model).toBe(returned);
    expect(result.usage.total_tokens).toBe(9);
    expect(result._routed_via).toEqual({ platform, model: requested });
    expect(fetch.mock.calls[0][0]).toBe(`${base}/chat/completions`);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: requested, max_tokens: 64, temperature: 0.2 });
    fetch.mockResolvedValue(stream(returned));
    const emitted = [];
    for await (const chunk of provider.streamChatCompletion('test-key', [], requested)) emitted.push(chunk);
    expect(emitted.flatMap(c => c.choices).map(c => c.delta.content ?? '').join('')).toBe('17');
  });

  it.each(['clod', 'blaze'] as const)('%s rejects substitutions and missing identity before emitting content', async platform => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const provider = getProvider(platform)!;
    for (const returned of ['google/gemma-4-31B-it', '']) {
      fetch.mockResolvedValue(json(completion(returned)));
      await expect(provider.chatCompletion('test-key', [], 'Llama 3.3 70B')).rejects.toMatchObject({ status: 502 });
      fetch.mockResolvedValue(stream(returned));
      const emitted = [];
      const consume = async () => { for await (const c of provider.streamChatCompletion('test-key', [], 'Llama 3.3 70B')) emitted.push(c); };
      await expect(consume()).rejects.toMatchObject({ status: 502 });
      expect(emitted).toEqual([]);
    }
  });

  it.each(['clod', 'blaze'] as const)('%s preserves provider backoff and never retries a paid route', async platform => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: { message: 'Quota exhausted' } }, 429, { 'Retry-After': '60' }));
    await expect(getProvider(platform)!.chatCompletion('test-key', [], 'test-model')).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Speechify never calls an imaginary chat endpoint', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const provider = getProvider('speechify')!;
    await expect(provider.chatCompletion('test-key', [], 'simba-3.2')).rejects.toMatchObject({ status: 400 });
    await expect(provider.streamChatCompletion('test-key', [], 'simba-3.2').next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
