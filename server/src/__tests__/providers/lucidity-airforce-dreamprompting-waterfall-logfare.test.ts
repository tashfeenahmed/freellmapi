import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider, hasProvider } from '../../providers/index.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const completion = (model: string) => ({ id: 'test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: '17' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } });
const stream = (model: string) => new Response(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model,
  choices: [{ index: 0, delta: { content: '17' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });

const PLATFORMS = ['lucidity', 'airforce', 'dreamprompting', 'waterfall', 'logfare'] as const;
const BASE: Record<(typeof PLATFORMS)[number], string> = {
  lucidity: 'https://composite.lucidity.sh/v1',
  airforce: 'https://api.airforce/v1',
  dreamprompting: 'https://dreamprompting.com/api/v1',
  waterfall: 'https://api.getwaterfall.org/v1',
  logfare: 'https://logfare.ai/v1',
};

describe('Lucidity Composite, Api.Airforce, DreamPrompting, Waterfall and Logfare adapters', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(PLATFORMS)('%s validates on the authenticated /models endpoint', async platform => {
    expect(hasProvider(platform)).toBe(true);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [] }));
    await expect(getProvider(platform)!.validateKey('test-key')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(`${BASE[platform]}/models`);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer test-key');
    fetch.mockResolvedValue(json({ error: 'Invalid key' }, 401));
    await expect(getProvider(platform)!.validateKey('test-key')).resolves.toMatchObject({ valid: false });
    fetch.mockResolvedValue(json({ error: 'Unavailable' }, 503));
    await expect(getProvider(platform)!.validateKey('test-key')).rejects.toThrow();
  });

  it.each([
    // Lucidity: `:free` is dropped in the echo; synth routes report the gateway's preview id.
    ['lucidity', 'lucidityai/synth-2.5-flash:free', 'synth-2.5-preview'],
    ['lucidity', 'lucidityai/synth-2.5-pro:free', 'synth-2.5-preview'],
    ['lucidity', 'inclusionai/ling-3.0-flash:free', 'inclusionai/ling-3.0-flash'],
    ['lucidity', 'mistralai/mistral-nemo:free', 'mistralai/mistral-nemo'],
    ['airforce', 'gpt-oss-120b', 'gpt-oss-120b'],
    // DreamPrompting: the upstream prefix is dropped in the echo; `auto` may report anything.
    ['dreamprompting', 'groq/openai/gpt-oss-20b', 'openai/gpt-oss-20b'],
    ['dreamprompting', 'nvidia/nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-super-120b-a12b'],
    ['dreamprompting', 'codestral/codestral-latest', 'codestral-latest'],
    ['dreamprompting', 'chat/ch.at', 'ch.at'],
    ['dreamprompting', 'openrouter/some/model:free', 'some/model'],
    ['dreamprompting', 'auto', 'whatever/served-it'],
    ['waterfall', 'llama-3.3-70b-free', 'llama-3.3-70b-free'],
    ['logfare', 'logfare/auto', 'logfare/auto'],
    ['logfare', 'gemma-4-26b', 'gemma-4-26b'],
  ] as const)('%s sends exact requested IDs and accepts a matching upstream identity (%s)', async (platform, requested, returned) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(completion(returned)));
    const provider = getProvider(platform)!;
    const result = await provider.chatCompletion('test-key', [{ role: 'user', content: '8+9' }], requested, { max_tokens: 64, temperature: 0.2 });
    expect(result.model).toBe(returned);
    expect(result.usage.total_tokens).toBe(9);
    expect(result._routed_via).toEqual({ platform, model: requested });
    expect(fetch.mock.calls[0][0]).toBe(`${BASE[platform]}/chat/completions`);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: requested, max_tokens: 64, temperature: 0.2 });
    fetch.mockResolvedValue(stream(returned));
    const emitted = [];
    for await (const chunk of provider.streamChatCompletion('test-key', [], requested)) emitted.push(chunk);
    expect(emitted.flatMap(c => c.choices).map(c => c.delta.content ?? '').join('')).toBe('17');
  });

  it.each([
    // Lucidity's `open/*` routes were observed silently answering as synth-2.5-preview.
    ['lucidity', 'open/some-model:free', ['synth-2.5-preview', 'mistralai/mistral-nemo', '']],
    ['airforce', 'gpt-oss-120b', ['gpt-oss-20b', 'openai/gpt-oss-120b', '']],
    ['dreamprompting', 'groq/openai/gpt-oss-20b', ['openai/gpt-oss-120b', 'gpt-oss-20b', '']],
    ['waterfall', 'llama-3.3-70b-free', ['llama-3.3-70b', '']],
    ['logfare', 'gemma-4-26b', ['logfare/auto', '']],
  ] as const)('%s rejects substitutions and missing identity before emitting content', async (platform, requested, substitutions) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const provider = getProvider(platform)!;
    for (const returned of substitutions) {
      fetch.mockResolvedValue(json(completion(returned)));
      await expect(provider.chatCompletion('test-key', [], requested)).rejects.toMatchObject({ status: 502 });
      fetch.mockResolvedValue(stream(returned));
      const emitted = [];
      const consume = async () => { for await (const c of provider.streamChatCompletion('test-key', [], requested)) emitted.push(c); };
      await expect(consume()).rejects.toMatchObject({ status: 502 });
      expect(emitted).toEqual([]);
    }
  });

  it.each(PLATFORMS)('%s preserves provider backoff and never retries a 429', async platform => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: { message: 'Quota exhausted' } }, 429, { 'Retry-After': '60' }));
    await expect(getProvider(platform)!.chatCompletion('test-key', [], 'test-model')).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Waterfall surfaces a structured upstream_unavailable body as a 503 provider error', async () => {
    const body = { detail: { type: 'waterfall_transport_error', code: 'upstream_unavailable' } };
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(body, 503));
    const provider = getProvider('waterfall')!;
    await expect(provider.chatCompletion('test-key', [], 'llama-3.3-70b-free')).rejects.toMatchObject({ status: 503 });
    await expect(provider.streamChatCompletion('test-key', [], 'llama-3.3-70b-free').next()).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('Logfare surfaces a premium-model 403 as a provider error and passes reasoning_content and neurons through', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: { message: 'This is a premium model' } }, 403));
    const provider = getProvider('logfare')!;
    await expect(provider.chatCompletion('test-key', [], 'premium-model')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('premium model') });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(json({ ...completion('gemma-4-26b'),
      choices: [{ index: 0, message: { role: 'assistant', content: '17', reasoning_content: '8+9=17' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9, neurons: 3 } }));
    const result = await provider.chatCompletion('test-key', [], 'gemma-4-26b');
    expect(result.choices[0].message).toMatchObject({ content: '17', reasoning_content: '8+9=17' });
    expect(result.usage).toMatchObject({ total_tokens: 9, neurons: 3 });
  });
});
