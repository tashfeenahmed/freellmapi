import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import { SpekaProvider } from '../../providers/speka.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';

const model = 'z-ai/glm-5.3';
const completion = {
  id: 'speka-test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
};
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

describe('Speka provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers separately from Speko and supports key-file imports', () => {
    expect(getProvider('speka')).toBeInstanceOf(SpekaProvider);
    expect(detectPlatform('SPEKA_')).toBe('speka');
    expect(AUTH_JSON_PROVIDER_MAP.speka).toBe('speka');
    expect(parseKeysFromFile('SPEKA_API_KEY=sk-speka-live-test-not-a-real-key', 'keys.env').keys[0].platform).toBe('speka');
  });

  it('uses bearer auth and preserves the requested model, options, usage and attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion));
    const result = await getProvider('speka')!.chatCompletion('test-key', [{ role: 'user', content: 'Reply OK' }], model, {
      max_tokens: 128, temperature: 0.2, response_format: { type: 'json_object' },
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://speka.me/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(init?.body)).stream).not.toBe(true);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2,
      response_format: { type: 'json_object' }, tools: [{ function: { name: 'lookup' } }] });
    expect(result.usage).toEqual(completion.usage);
    expect(result.choices[0].message.content).toBe('OK');
    expect(result._routed_via).toEqual({ platform: 'speka', model });
  });

  it('streams OpenAI SSE and preserves usage', async () => {
    const chunks = [
      { id: 's', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
      { id: 's', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: completion.usage },
    ];
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    const out: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('speka')!.streamChatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model)) out.push(chunk);
    expect(out.flatMap(c => c.choices).map(c => c.delta.content ?? '').join('')).toBe('OK');
    expect(out.some(c => c.usage?.total_tokens === 6)).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).stream).toBe(true);
  });

  it('validates through authenticated model resolution, never the public model list', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { type: 'model_not_found', code: 400 } }, 400));
    await expect(getProvider('speka')!.validateKey('test-key')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://speka.me/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: '__freellmapi_key_validation__', max_tokens: 1, stream: false });
  });

  it.each([401, 403])('rejects authentication errors (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { type: 'authentication_error', message: 'Invalid API key' } }, status));
    await expect(getProvider('speka')!.validateKey('bad-key')).resolves.toMatchObject({ valid: false });
  });

  it.each([200, 400, 402, 429, 500])('does not accept an inconclusive key check (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { type: 'other' } }, status, { 'Retry-After': '17' }));
    await expect(getProvider('speka')!.validateKey('test-key')).rejects.toMatchObject({ status, retryAfterMs: 17_000 });
  });

  it('does not accept a malformed validation response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not JSON', { status: 400 }));
    await expect(getProvider('speka')!.validateKey('test-key')).rejects.toMatchObject({ status: 400 });
  });

  it.each([402, 429])('preserves exhausted-credit/rate-limit responses and Retry-After (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Allowance exhausted' } }, status, { 'Retry-After': '30' }));
    await expect(getProvider('speka')!.chatCompletion('test-key', [], model)).rejects.toMatchObject({ status, retryAfterMs: 30_000 });
  });
});
