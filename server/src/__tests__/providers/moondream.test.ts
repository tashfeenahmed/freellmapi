import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk, ChatMessage } from '@freellmapi/shared/types.js';
import { MoondreamProvider } from '../../providers/moondream.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { supportedParametersFor } from '../../lib/sampling-params.js';
import { isRetryableError } from '../../lib/error-classify.js';

const model = 'moondream3.1-9B-A2B';
const messages: ChatMessage[] = [{ role: 'user', content: 'Say OK' }];
const image = 'data:image/jpeg;base64,YWJj';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const completion = () => ({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK', reasoning: 'A thought.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: 'chatcmpl-test',
  object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] });
const sse = (frames: unknown[], done = true) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''),
  { headers: { 'Content-Type': 'text/event-stream' } });
async function collect(source: AsyncGenerator<ChatCompletionChunk>) {
  const result: ChatCompletionChunk[] = [];
  for await (const value of source) result.push(value);
  return result;
}

describe('Moondream hosted adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers the provider and key import, and advertises only implemented parameters', () => {
    expect(getProvider('moondream')).toBeInstanceOf(MoondreamProvider);
    expect(detectPlatform('MOONDREAM_')).toBe('moondream');
    expect(parseKeysFromFile('MOONDREAM_API_KEY=test-key', 'keys.env').keys[0]?.platform).toBe('moondream');
    expect(AUTH_JSON_PROVIDER_MAP.moondream).toBe('moondream');
    expect(supportedParametersFor('moondream', { tools: true })).toEqual([
      'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stream', 'reasoning_effort',
    ]);
  });

  it('maps token/reasoning options, preserves zero sampling and normalizes output', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const result = await new MoondreamProvider().chatCompletion('test-key', messages, model,
      { max_tokens: 32, temperature: 0, top_p: 0, reasoning_effort: 'none', seed: 1 });
    expect(fetch.mock.calls[0][0]).toBe('https://api.moondream.ai/v1/chat/completions');
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, messages, stream: false,
      max_completion_tokens: 32, temperature: 0, top_p: 0, reasoning: false });
    expect(result.choices[0].message).toEqual({ role: 'assistant', content: 'OK', reasoning_content: 'A thought.' });
    expect(result.usage.total_tokens).toBe(15);
    expect(result._routed_via).toEqual({ platform: 'moondream', model });
  });

  it('clamps max_completion_tokens to the route\'s remaining context budget', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await new MoondreamProvider().chatCompletion('k', messages, model, { max_tokens: 2048, contextBudget: 300 });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).max_completion_tokens).toBe(300);
  });

  it('preserves vision input, strips replay-only fields and obeys upstream output ceiling', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await new MoondreamProvider().chatCompletion('k', [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: ['Look', { type: 'image_url', image_url: { url: image, detail: 'high' } }] },
      { role: 'assistant', content: 'OK', reasoning_content: 'private', partial: true },
      ...messages,
    ], model, { max_tokens: 8000, reasoning_effort: 'high' });
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.reasoning).toBe(true);
    expect(body.messages[1].content).toEqual([{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: image } }]);
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'OK' });
  });

  it.each([
    { stop: ['end'] },
    { tools: [{ type: 'function' as const, function: { name: 'f' } }] },
    { tool_choice: 'required' as const },
    { response_format: { type: 'json_object' as const } },
  ])('fails over unsupported request options before fetching: %j', async options => {
    const fetch = vi.spyOn(global, 'fetch');
    const error = await new MoondreamProvider().chatCompletion('k', messages, model, options).catch(e => e);
    expect(error.status).toBe(422);
    expect(isRetryableError(error)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each<ChatMessage[]>([
    [{ role: 'tool', tool_call_id: 'a', content: 'OK' }],
    [{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }] }],
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }],
    [{ role: 'user', content: [{ type: 'input_audio', text: 'not a text part' }] }],
  ])('rejects incompatible history/media without downloading URLs: %j', async message => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(new MoondreamProvider().chatCompletion('k', [message], model)).rejects.toMatchObject({ status: 422 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates only authenticated keys without inference, keeping outages inconclusive', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ data: [{ id: model }] }))
      .mockResolvedValueOnce(json({ error: 'Invalid API key' }, 401))
      .mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({}));
    const provider = new MoondreamProvider();
    await expect(provider.validateKey('')).resolves.toMatchObject({ valid: false });
    expect(fetch).not.toHaveBeenCalled();
    await expect(provider.validateKey('key')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.moondream.ai/v1/models');
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer key' });
    await expect(provider.validateKey('bad')).resolves.toMatchObject({ valid: false });
    await expect(provider.validateKey('key')).rejects.toMatchObject({ status: 503 });
    await expect(provider.validateKey('key')).rejects.toMatchObject({ status: 502 });
  });

  it.each([
    { model: 'wrong' }, { model: undefined }, { choices: [] },
    { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: 'unfinished' }, finish_reason: null }] },
  ])('rejects substituted or invalid completions: %j', async override => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), ...override }));
    await expect(new MoondreamProvider().chatCompletion('k', messages, model)).rejects.toMatchObject({ status: 502 });
  });

  it('streams native SSE with normalized reasoning and opt-in usage', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockImplementation(async () => sse([
      chunk({ role: 'assistant' }), chunk({ reasoning: 'Think' }), chunk({ content: 'OK' }), chunk({}, 'stop'),
      { ...chunk({}), choices: [], usage: completion().usage },
    ]));
    const provider = new MoondreamProvider();
    const frames = await collect(provider.streamChatCompletion('k', messages, model, { max_tokens: 32, stream_options: { include_usage: true } }));
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_completion_tokens: 32 });
    expect(frames[1].choices[0].delta).toEqual({ reasoning_content: 'Think' });
    expect(frames.at(-1)?.usage?.total_tokens).toBe(15);
    expect((await collect(provider.streamChatCompletion('k', messages, model))).every(frame => frame.choices.length > 0)).toBe(true);
  });

  it('rejects substituted streaming identities before yielding', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([{ ...chunk({ content: 'oops' }), model: 'wrong' }]));
    await expect(new MoondreamProvider().streamChatCompletion('k', messages, model).next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([true, false])('detects missing terminal completion, DONE=%s', async done => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([chunk({ content: 'partial' })], done));
    await expect(collect(new MoondreamProvider().streamChatCompletion('k', messages, model))).rejects.toThrow(/stream ended/);
  });

  it('preserves 429 status/backoff even for non-JSON errors', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('Rate limited', { status: 429, headers: { 'Retry-After': '12' } }));
    const provider = new MoondreamProvider();
    await expect(provider.chatCompletion('k', messages, model)).rejects.toMatchObject({ status: 429, retryAfterMs: 12000 });
    await expect(provider.streamChatCompletion('k', messages, model).next()).rejects.toMatchObject({ status: 429, retryAfterMs: 12000 });
  });

  it('cancels a stalled response body on disconnect', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        if (init?.signal?.aborted) controller.error(init.signal.reason);
        else init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    })));
    const controller = new AbortController();
    const pending = new MoondreamProvider().chatCompletion('k', messages, model, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
