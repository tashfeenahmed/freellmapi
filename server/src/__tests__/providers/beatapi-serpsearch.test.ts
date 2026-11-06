import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeatApiProvider } from '../../providers/beatapi.js';
import { SerpSearchProvider } from '../../providers/serpsearch.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
afterEach(() => vi.restoreAllMocks());

describe.each([
  { platform: 'beatapi' as const, provider: new BeatApiProvider() },
  { platform: 'serpsearch' as const, provider: new SerpSearchProvider() },
])('$platform credentials', ({ platform, provider }) => {
  it('registers and imports explicitly named keys', () => {
    expect(getProvider(platform)).toBeInstanceOf(provider.constructor);
    expect(parseKeysFromFile(`${platform.toUpperCase()}_API_KEY=unit-test-only`, 'keys.env').keys[0].platform).toBe(platform);
    expect(AUTH_JSON_PROVIDER_MAP[platform]).toBe(platform);
  });

  it.skipIf(platform === 'beatapi')('rejects ordinary and streaming chat without making a request', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    const base = getProvider(platform)!;
    await expect(base.chatCompletion('k', [], 'm')).rejects.toMatchObject({ status: 422 });
    await expect(base.streamChatCompletion('k', [], 'm').next()).rejects.toMatchObject({ status: 422 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('forwards BeatAPI tool calls in chat responses', async () => {
  vi.spyOn(global, 'fetch').mockResolvedValue(json({ id: 'chat-1', object: 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
  const result = await new BeatApiProvider().chatCompletion('test-key', [{ role: 'user', content: 'hello' }], 'test-model');
  expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('lookup');
});

it.each([null, {}, { data: {} }, { data: [], error: 'failure' }])('rejects malformed BeatAPI lists', async body => {
  vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
  await expect(new BeatApiProvider().validateKey('k')).rejects.toMatchObject({ status: 502 });
});

describe('BeatAPI key validation', () => {
  it('validates without spending search or inference quota', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [{ id: 'jev-1.14-free' }] }));
    expect(await new BeatApiProvider().validateKey('unit-test-key')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.beatapi.io/v1/models');
    const init = fetch.mock.calls[0][1]!;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer unit-test-key');
  });

  it.each([401, 403])('rejects HTTP %s authentication failures', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Invalid API key' } }, status));
    await expect(new BeatApiProvider().validateKey('invalid')).resolves.toMatchObject({ valid: false });
  });

  it.each([429, 500, 503])('keeps HTTP %s inconclusive with retry hints', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({}, status, { 'Retry-After': '60' }));
    await expect(new BeatApiProvider().validateKey('unit-test-key')).rejects.toMatchObject({ status, retryAfterMs: 60_000 });
  });

});

// #1599: SerpSearch's maintainer asked for no empty-query requests at all, and
// it has no other endpoint that proves a key, so nothing validates its keys.
it('never sends a request to validate a SerpSearch key', async () => {
  const fetch = vi.spyOn(global, 'fetch');
  const provider = new SerpSearchProvider();
  expect(provider.supportsKeyValidation).toBe(false);
  expect(provider.supportsKeyPolling).toBe(false);
  await expect(provider.validateKey()).rejects.toThrow(/no request sent/);
  expect(fetch).not.toHaveBeenCalled();
});
