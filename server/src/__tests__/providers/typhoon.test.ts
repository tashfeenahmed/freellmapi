import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import { TyphoonProvider, TYPHOON_BASE_URL } from '../../providers/typhoon.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';

const model = 'typhoon-v2.5-30b-a3b-instruct';
const completion = {
  id: 'typhoon-test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
};
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

describe('Typhoon provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers a keyed provider and recognizes explicit key-file names', () => {
    expect(getProvider('typhoon')).toBeInstanceOf(TyphoonProvider);
    expect(getProvider('typhoon')!.keyless).toBe(false);
    for (const prefix of ['TYPHOON', 'OPENTYPHOON', 'OPEN_TYPHOON']) {
      expect(parseKeysFromFile(`${prefix}_API_KEY=sk-test-not-a-real-key`, 'keys.env').keys[0].platform).toBe('typhoon');
    }
    for (const alias of ['typhoon', 'opentyphoon', 'open-typhoon']) expect(AUTH_JSON_PROVIDER_MAP[alias]).toBe('typhoon');
  });

  it('preserves chat parameters, usage, and provider attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion));
    const response = await getProvider('typhoon')!.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model, {
      max_tokens: 128, temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    });
    expect(fetch.mock.calls[0][0]).toBe(`${TYPHOON_BASE_URL}/chat/completions`);
    const init = fetch.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2, tools: [{ function: { name: 'lookup' } }] });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion.usage);
    expect(response._routed_via).toEqual({ platform: 'typhoon', model });
  });

  it('handles Typhoon SSE ending at EOF without a DONE sentinel or usage chunk', async () => {
    const chunks = [
      { id: 's', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'OK', tool_calls: [] }, finish_reason: null }] },
      { id: 's', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: null, tool_calls: null }, finish_reason: 'stop' }] },
    ];
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
    const output: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('typhoon')!.streamChatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model)) output.push(chunk);
    expect(output.flatMap(c => c.choices).map(c => c.delta.content ?? '').join('')).toBe('OK');
    expect(output.some(c => c.choices.some(x => x.finish_reason === 'stop'))).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).stream).toBe(true);
  });

  it('validates using the exact authenticated model-not-found response, not public models', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ detail: 'Model not found' }, 400));
    await expect(getProvider('typhoon')!.validateKey('test-key')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`${TYPHOON_BASE_URL}/chat/completions`);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: '__freellmapi_key_validation__', max_tokens: 1, stream: false });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
  });

  it.each([401, 403])('rejects invalid credentials (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ detail: 'Invalid API Key' }, status));
    await expect(getProvider('typhoon')!.validateKey('invalid')).resolves.toMatchObject({ valid: false });
  });

  it.each([200, 400, 402, 404, 429, 500])('leaves other validation responses inconclusive (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ detail: 'Something else' }, status, { 'Retry-After': '17' }));
    await expect(getProvider('typhoon')!.validateKey('test-key')).rejects.toMatchObject({ status, retryAfterMs: 17_000 });
  });

  it('does not accept malformed validation JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not JSON', { status: 400 }));
    await expect(getProvider('typhoon')!.validateKey('test-key')).rejects.toMatchObject({ status: 400 });
  });

  it('preserves rate limits and their retry delay', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ detail: 'Rate limit exceeded' }, 429, { 'Retry-After': '30' }));
    await expect(getProvider('typhoon')!.chatCompletion('test-key', [], model)).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
  });
});
