import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlugskyProvider, PLUGSKY_BASE_URL } from '../../providers/plugsky.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';

const model = 'plugsky-micro';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

describe('Plugsky', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers the keyed provider and explicit key-file aliases', () => {
    expect(getProvider('plugsky')).toBeInstanceOf(PlugskyProvider);
    expect(getProvider('plugsky')!.keyless).toBe(false);
    expect(parseKeysFromFile('PLUGSKY_API_KEY=sk-live-test', 'keys.env').keys[0].platform).toBe('plugsky');
    expect(AUTH_JSON_PROVIDER_MAP.plugsky).toBe('plugsky');
  });

  it('validates through authenticated usage without consuming inference', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [] }));
    expect(await new PlugskyProvider().validateKey('test-key')).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${PLUGSKY_BASE_URL}/plugsky/usage`);
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('rejects authentication failure %s', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Invalid API key' } }, status));
    await expect(new PlugskyProvider().validateKey('bad-key')).resolves.toMatchObject({ valid: false });
  });

  it.each([402, 429, 503])('does not treat HTTP %s as a validated or invalid key', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({}, status, { 'Retry-After': '19' }));
    await expect(new PlugskyProvider().validateKey('test-key')).rejects.toMatchObject({ status, retryAfterMs: 19_000 });
  });

  it.each(['<html>Login</html>', '{}', 'null'])('rejects an unexpected successful usage body', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
    await expect(new PlugskyProvider().validateKey('test-key')).rejects.toMatchObject({ status: 502 });
  });

  it('preserves chat, JSON mode, token usage and route attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({
      id: 'test', object: 'chat.completion', created: 1, model,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    }));
    const result = await new PlugskyProvider().chatCompletion('test-key', [{ role: 'user', content: 'JSON please' }], model,
      { max_tokens: 64, temperature: 0.2, response_format: { type: 'json_object' } });
    expect(fetch.mock.calls[0][0]).toBe(`${PLUGSKY_BASE_URL}/chat/completions`);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 64, temperature: 0.2, response_format: { type: 'json_object' } });
    expect(result.choices[0].message.content).toBe('{"ok":true}');
    expect(result.usage?.total_tokens).toBe(9);
    expect(result._routed_via).toEqual({ platform: 'plugsky', model });
  });

  it('streams SSE content and preserves usage', async () => {
    const frames = [
      { id: 's', object: 'chat.completion.chunk', created: 1, model: 'upstream-model', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
      { id: 's', object: 'chat.completion.chunk', created: 1, model: 'upstream-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ];
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(frames.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n'));
    const chunks = [];
    for await (const chunk of new PlugskyProvider().streamChatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model)) chunks.push(chunk);
    expect(chunks.map(c => c.choices[0]?.delta.content ?? '').join('')).toBe('OK');
    expect(chunks.find(c => c.usage)?.usage?.total_tokens).toBe(4);
    // Live SSE identifies the backing upstream, unlike non-streaming aliases.
    expect(chunks[0].model).toBe('upstream-model');
  });

  it('preserves chat rate limits and Retry-After', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Rate limited' } }, 429, { 'Retry-After': '12' }));
    await expect(new PlugskyProvider().chatCompletion('test-key', [], model)).rejects.toMatchObject({ status: 429, retryAfterMs: 12_000 });
  });
});
