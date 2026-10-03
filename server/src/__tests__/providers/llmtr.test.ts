import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

// Collapse the #1369 validation min-gap before the provider module loads.
vi.hoisted(() => { process.env.LLMTR_VALIDATION_MIN_GAP_MS = '0'; });

import { LlmtrProvider } from '../../providers/llmtr.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';

const model = 'qwen/qwen3.8-27b-free';
const completion = { id: 'llmtr-test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const sse = (returnedModel: string) => new Response([
  { id: 's', object: 'chat.completion.chunk', created: 1, model: returnedModel, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] },
  { id: 's', object: 'chat.completion.chunk', created: 1, model: returnedModel, choices: [], usage: completion.usage },
].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

describe('LLMTR provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('llmtr')).toBeInstanceOf(LlmtrProvider);
    expect(detectPlatform('LLMTR_')).toBe('llmtr');
    expect(AUTH_JSON_PROVIDER_MAP.llmtr).toBe('llmtr');
    expect(parseKeysFromFile('LLMTR_API_KEY=llmtr-test-not-a-real-key', 'keys.env').keys[0].platform).toBe('llmtr');
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('llmtr');
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion));
    const response = await getProvider('llmtr')!.chatCompletion('test-key', [{ role: 'user', content: 'OK' }], model,
      { max_tokens: 128, temperature: 0.2, response_format: { type: 'json_object' } });
    expect(fetch.mock.calls[0][0]).toBe('https://llmtr.com/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2, response_format: { type: 'json_object' } });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion.usage);
    expect(response._routed_via).toEqual({ platform: 'llmtr', model });
  });

  it('streams content and usage with the requested model', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(sse(model));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('llmtr')!.streamChatCompletion('test-key', [], model)) chunks.push(chunk);
    expect(chunks.flatMap(c => c.choices).map(c => c.delta.content ?? '').join('')).toBe('OK');
    expect(chunks.some(c => c.usage?.total_tokens === 6)).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).stream).toBe(true);
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion, model: returnedModel }));
    await expect(getProvider('llmtr')!.chatCompletion('test-key', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse('other-model'));
    const stream = getProvider('llmtr')!.streamChatCompletion('test-key', [], model);
    await expect(stream.next()).rejects.toMatchObject({ status: 502 });
  });

  it('validates via authenticated model resolution, not the public roster', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { type: 'model_not_found', message: 'Model not found' } }, 404));
    await expect(getProvider('llmtr')!.validateKey('test-key')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://llmtr.com/v1/chat/completions');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: '__freellmapi_key_validation__', max_tokens: 1, stream: false });
  });

  it.each([401, 403])('rejects invalid credentials (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { type: 'auth_error', message: 'Invalid API key' } }, status));
    await expect(getProvider('llmtr')!.validateKey('bad-key')).resolves.toMatchObject({ valid: false });
  });

  it.each([200, 400, 402, 404, 429, 500])('keeps inconclusive validation errors inconclusive (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { type: 'other' } }, status, { 'Retry-After': '17' }));
    await expect(getProvider('llmtr')!.validateKey('test-key')).rejects.toMatchObject({ status, retryAfterMs: 17_000 });
  });

  it('does not accept an HTML 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not JSON', { status: 404 }));
    await expect(getProvider('llmtr')!.validateKey('test-key')).rejects.toMatchObject({ status: 404 });
  });

  it.each([402, 429])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Quota exhausted' } }, status, { 'Retry-After': '30' }));
    await expect(getProvider('llmtr')!.chatCompletion('test-key', [], model)).rejects.toMatchObject({ status, retryAfterMs: 30_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
