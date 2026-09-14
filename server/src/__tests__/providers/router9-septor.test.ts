import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import { getProvider, hasProvider } from '../../providers/index.js';
import { isRetryableError } from '../../lib/error-classify.js';

const credits = { 'x-credits-limit': '50000', 'x-credits-remaining': '49998.4484' };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function completion(model: string, content = '42') {
  return { id: 'test', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
}
function chunk(model: string, content?: string, finish: 'stop' | null = null): ChatCompletionChunk {
  return { id: 'test', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta: content === undefined ? { role: 'assistant' } : { content }, finish_reason: finish }] };
}
function sse(chunks: ChatCompletionChunk[], done = false) {
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
async function collect(source: AsyncGenerator<ChatCompletionChunk>) {
  const result: ChatCompletionChunk[] = [];
  for await (const c of source) result.push(c);
  return result;
}

describe('Router9 and Septor adapters', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['router9', 'https://api.router9.com/v1'],
    ['septor', 'https://api.septorlabs.com/v1'],
  ] as const)('%s registers and forwards auth, model, options and usage', async (platform, base) => {
    expect(hasProvider(platform)).toBe(true);
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('test-model')));
    const result = await getProvider(platform)!.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], 'test-model', {
      max_tokens: 128, temperature: 0.2, top_p: 0.8,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    });
    expect(fetch.mock.calls[0][0]).toBe(`${base}/chat/completions`);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: 'test-model', max_tokens: 128, temperature: 0.2, top_p: 0.8 });
    expect(result.usage.total_tokens).toBe(12);
    expect(result._routed_via).toEqual({ platform, model: 'test-model' });
  });

  it('Router9 validates using a no-generation auth probe, not its public roster', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { code: 'model_not_found' } }, 404, credits));
    await expect(getProvider('router9')!.validateKey('test-key')).resolves.toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.router9.com/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ messages: [] });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
  });

  it('Router9 rejects invalid credentials', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'Invalid API key' }, 401));
    await expect(getProvider('router9')!.validateKey('bad-test-key')).resolves.toMatchObject({ valid: false });
  });

  it.each([402, 429])('Router9 keeps authenticated but exhausted keys valid (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'Quota exhausted' }, status, { ...credits, 'x-credits-remaining': '0' }));
    await expect(getProvider('router9')!.validateKey('test-key')).resolves.toBe(true);
  });

  it.each([
    [404, {}, { error: { code: 'model_not_found' } }],
    [404, credits, { error: { code: 'not_found' } }],
    [404, { ...credits, 'x-credits-limit': '' }, { error: { code: 'model_not_found' } }],
    [404, { ...credits, 'x-credits-remaining': 'unknown' }, { error: { code: 'model_not_found' } }],
    [403, credits, { error: 'Forbidden' }],
    [429, {}, { error: 'Edge limit' }],
    [503, credits, { error: 'Unavailable' }],
    [200, {}, { data: [] }],
  ] as const)('Router9 does not misclassify an inconclusive response as a live or revoked key (%s)', async (status, headers, body) => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body, status, headers));
    await expect(getProvider('router9')!.validateKey('test-key')).rejects.toThrow('inconclusive');
  });

  it('Septor validates through its authenticated model endpoint', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [] }));
    await expect(getProvider('septor')!.validateKey('test-key')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.septorlabs.com/v1/models');
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
  });

  it.each([401, 403])('Septor rejects invalid credentials (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Invalid key' } }, status));
    await expect(getProvider('septor')!.validateKey('bad-test-key')).resolves.toMatchObject({ valid: false });
  });

  it('Router9 reuses inline-reasoning normalization for non-streaming answers', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('MiniMax-M3', '<think>19 + 23 = 42.</think>\n\n42')));
    const result = await getProvider('router9')!.chatCompletion('test-key', [], 'minimax/minimax-m3');
    expect(result.choices[0].message.content).toBe('42');
    expect(result.choices[0].message.reasoning_content).toBe('19 + 23 = 42.');
  });

  it('Router9 normalizes split think tags and preserves EOF-terminal usage without [DONE]', async () => {
    const model = 'MiniMax-M3';
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([
      chunk(model, '<thi'), chunk(model, 'nk>work</th'), chunk(model, 'ink>\n\n42', 'stop'),
      { id: 'test', object: 'chat.completion.chunk', created: 1, model, choices: [], usage },
    ]));
    const result = await collect(getProvider('router9')!.streamChatCompletion('test-key', [], 'minimax/minimax-m3'));
    expect(result.flatMap(c => c.choices).map(c => c.delta.content ?? '').join('')).toBe('42');
    expect(result.flatMap(c => c.choices).map(c => c.delta.reasoning_content ?? '').join('')).toBe('work');
    expect(result.at(-1)?.usage).toEqual(usage);
  });

  it('Router9 still rejects a genuinely truncated stream', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([chunk('MiniMax-M3', 'unfinished')]));
    await expect(collect(getProvider('router9')!.streamChatCompletion('test-key', [], 'minimax/minimax-m3'))).rejects.toThrow('stream ended unexpectedly');
  });

  it.each(['minimax-m2.5-free', ''])('Septor rejects substituted or missing non-streaming identity (%s)', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion(returned)));
    const error = await getProvider('septor')!.chatCompletion('test-key', [], 'qwen3-coder-free').catch(e => e);
    expect(error.status).toBe(502);
    expect(isRetryableError(error)).toBe(true);
  });

  it('Septor rejects a substituted stream before leaking content or tool calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([chunk('minimax-m2.5-free', 'wrong model', 'stop')]));
    const emitted: ChatCompletionChunk[] = [];
    const consume = async () => {
      for await (const c of getProvider('septor')!.streamChatCompletion('test-key', [], 'qwen3-coder-free')) emitted.push(c);
    };
    await expect(consume()).rejects.toMatchObject({ status: 502 });
    expect(emitted).toEqual([]);
  });

  it('Septor passes matching stream identities and usage', async () => {
    const model = 'qwen3-coder-free';
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([chunk(model, '42', 'stop')], true));
    const result = await collect(getProvider('septor')!.streamChatCompletion('test-key', [], model));
    expect(result[0].choices[0].delta.content).toBe('42');
  });

  it('Septor permits an explicitly requested auto route to name its chosen model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('minimax-m2.5-free')));
    await expect(getProvider('septor')!.chatCompletion('test-key', [], 'auto')).resolves.toMatchObject({ model: 'minimax-m2.5-free' });
  });

  it.each(['router9', 'septor'] as const)('%s preserves upstream backoff', async platform => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Rate limit reached' } }, 429, { 'Retry-After': '60' }));
    await expect(getProvider(platform)!.chatCompletion('test-key', [], 'test-model')).rejects.toMatchObject({ status: 429, retryAfterMs: 60_000 });
  });
});
