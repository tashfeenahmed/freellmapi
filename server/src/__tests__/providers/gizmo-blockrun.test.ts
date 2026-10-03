import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk, ChatMessage } from '@freellmapi/shared/types.js';
import { GizmoProvider } from '../../providers/gizmo.js';
import { BlockRunProvider } from '../../providers/blockrun.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { extendedBodyParams, platformDropsResponseFormat } from '../../lib/sampling-params.js';

const messages: ChatMessage[] = [{ role: 'user', content: 'Say OK' }];
const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
const completion = (model?: string) => ({ id: 'test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Retry-After': '30' } });
const sse = (model?: string, secondModel = model) => new Response([
  { id: 's', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] },
  { id: 's', object: 'chat.completion.chunk', created: 1, model: secondModel, choices: [], usage },
].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');

describe.each([
  ['gizmo', GizmoProvider, 'https://api.gizmoplatforms.com/api/v1', '/models'],
  ['blockrun', BlockRunProvider, 'https://api.blockrun.ai/v1', '/account'],
] as const)('%s provider', (platform, Provider, base, validationPath) => {
  afterEach(() => vi.restoreAllMocks());

  it('registers keys and leaves model rows to the signed catalog', () => {
    expect(getProvider(platform)).toBeInstanceOf(Provider);
    expect(AUTH_JSON_PROVIDER_MAP[platform]).toBe(platform);
    expect(parseKeysFromFile(`${platform.toUpperCase()}_API_KEY=test-not-a-real-key`, 'keys.env').keys[0].platform).toBe(platform);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain(platform);
  });

  it('preserves auth, exact model, usage and attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('test-model')));
    const response = await new Provider().chatCompletion('test-key', messages, 'test-model', { max_tokens: 1024, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe(`${base}/chat/completions`);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: 'test-model', max_tokens: 1024, temperature: 0.2 });
    expect(response.usage).toEqual(usage);
    expect(response._routed_via).toEqual({ platform, model: 'test-model' });
  });

  it('streams text and usage', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(sse('test-model'));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of new Provider().streamChatCompletion('key', messages, 'test-model', { stream_options: { include_usage: true } })) chunks.push(chunk);
    expect(chunks.flatMap(c => c.choices).map(c => c.delta.content ?? '').join('')).toBe('OK');
    expect(chunks.some(c => c.usage?.total_tokens === 6)).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('validates using an authenticated endpoint without inference', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({}));
    expect(await new Provider().validateKey('key')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(base + validationPath);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
  });

  it.each([401, 403])('rejects invalid credentials (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Invalid API key' } }, status));
    expect(await new Provider().validateKey('bad-key')).toMatchObject({ valid: false });
  });

  it.each([402, 429, 500, 503])('keeps transient/account validation failures inconclusive (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({}, status));
    await expect(new Provider().validateKey('key')).rejects.toMatchObject({ status, retryAfterMs: 30_000 });
  });

  it('preserves rate-limit backoff on inference', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Rate limited' } }, 429));
    await expect(new Provider().chatCompletion('key', messages, 'model')).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
  });
});

describe('Gizmo strict text payload', () => {
  afterEach(() => vi.restoreAllMocks());
  it('strips unknown options and replay fields and respects the upstream ceiling', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('model')));
    await new GizmoProvider().chatCompletion('key', [{ role: 'assistant', content: 'OK', reasoning_content: 'private', name: 'bot' }], 'model',
      { max_tokens: 100_000, seed: 7, reasoning_effort: 'high', response_format: { type: 'json_object' }, parallel_tool_calls: false });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model: 'model', messages: [{ role: 'assistant', content: 'OK' }], max_tokens: 32768 });
    expect(platformDropsResponseFormat('gizmo')).toBe(true);
    expect(extendedBodyParams('gizmo', { seed: 7, reasoning_effort: 'high' })).toEqual({});
  });
  it('supplies the documented default and flattens text-only content', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('model')));
    await new GizmoProvider().chatCompletion('key', [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }], 'model');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ messages: [{ role: 'user', content: 'OK' }], max_tokens: 1024 });
  });
  it.each([
    [{ role: 'tool', content: 'result', tool_call_id: 'a' }],
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }],
    [],
  ] as ChatMessage[][])('rejects unsupported messages before fetching', async (...input) => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(async () => new GizmoProvider().chatCompletion('key', input, 'model')).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects tool requests before fetching', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(async () => new GizmoProvider().chatCompletion('key', messages, 'model', { tools: [{ type: 'function', function: { name: 'test' } }] })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('BlockRun identity guard', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['other-model', undefined, ''])('rejects missing/substituted completion identity (%s)', async model => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion(model)));
    await expect(new BlockRunProvider().chatCompletion('key', messages, 'wanted')).rejects.toMatchObject({ status: 502 });
  });
  it.each(['other-model', undefined, ''])('rejects before yielding substituted/missing stream identity (%s)', async model => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse(model));
    await expect(new BlockRunProvider().streamChatCompletion('key', messages, 'wanted').next()).rejects.toMatchObject({ status: 502 });
  });
  it('does not allow identity changes mid-stream', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse('wanted', 'other-model'));
    const stream = new BlockRunProvider().streamChatCompletion('key', messages, 'wanted');
    expect((await stream.next()).value?.model).toBe('wanted');
    await expect(stream.next()).rejects.toMatchObject({ status: 502 });
  });
});
