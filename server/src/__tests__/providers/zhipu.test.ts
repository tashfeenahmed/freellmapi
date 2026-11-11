import { describe, it, expect, vi, afterEach } from 'vitest';
import { ZhipuProvider } from '../../providers/zhipu.js';

const DOMESTIC = 'https://open.bigmodel.cn/api/paas/v4';
const GLOBAL = 'https://api.z.ai/api/paas/v4';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Minimal catalog/chat responses. status alone decides the validation verdict. */
const catalogRes = (status: number, message?: string) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 401 ? 'Unauthorized' : 'OK',
  headers: new Headers(),
  json: () => Promise.resolve(
    status === 401 ? { error: { message: message ?? 'invalid api key' } } : { data: [] },
  ),
}) as unknown as Response;

const chatRes = () => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: () => Promise.resolve({
    id: 'id', object: 'chat.completion', created: 1, model: 'glm-4.5-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }),
}) as unknown as Response;

/** Record every URL fetched and answer from a per-host table. */
function mockHosts(table: Array<[string, () => Response]>) {
  const urls: string[] = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (url: string | URL | Request) => {
    const str = String(url);
    urls.push(str);
    const hit = table.find(([prefix]) => str.startsWith(prefix));
    if (!hit) throw new Error(`unexpected host: ${str}`);
    return hit[1]();
  }) as typeof fetch);
  return urls;
}

describe('ZhipuProvider console autodetect', () => {
  it('keeps the domestic host when the domestic console accepts the key', async () => {
    const provider = new ZhipuProvider();
    const urls = mockHosts([[DOMESTIC, () => catalogRes(200)]]);

    expect(await provider.validateKey('cn-key')).toBe(true);

    // One probe, no speculative round-trip to api.z.ai for a key that works.
    expect(urls).toEqual([`${DOMESTIC}/models`]);

    await provider.chatCompletion('cn-key', [{ role: 'user', content: 'hi' }], 'glm-4.5-flash');
    expect(urls[1]).toBe(`${DOMESTIC}/chat/completions`);
  });

  it('falls back to the global host on a domestic 401 and caches it for the key', async () => {
    const provider = new ZhipuProvider();
    const urls = mockHosts([
      [DOMESTIC, () => catalogRes(401)],
      [GLOBAL, () => catalogRes(200)],
    ]);

    expect(await provider.validateKey('zai-key')).toBe(true);

    // Domestic first (it stays the default), global only as the fallback.
    expect(urls).toEqual([`${DOMESTIC}/models`, `${GLOBAL}/models`]);

    // The cached verdict has to reach ordinary traffic, not just validation.
    await provider.chatCompletion('zai-key', [{ role: 'user', content: 'hi' }], 'glm-4.5-flash');
    expect(urls[2]).toBe(`${GLOBAL}/chat/completions`);
  });

  it.each([302, 404, 429, 500])('does not accept or pin a global key when its probe returns HTTP %s', async (status) => {
    const provider = new ZhipuProvider();
    const urls = mockHosts([
      [DOMESTIC, () => catalogRes(401)],
      [GLOBAL, () => catalogRes(status)],
    ]);

    await expect(provider.validateKey('uncertain-key')).rejects.toMatchObject({ status });
    expect(urls).toEqual([`${DOMESTIC}/models`, `${GLOBAL}/models`]);

    vi.spyOn(global, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      urls.push(String(url));
      return chatRes();
    }) as typeof fetch);
    await provider.chatCompletion('uncertain-key', [{ role: 'user', content: 'hi' }], 'glm-4.5-flash');
    expect(urls.at(-1)).toBe(`${DOMESTIC}/chat/completions`);
  });

  it('retains the global server retry hint on an inconclusive validation', async () => {
    const provider = new ZhipuProvider();
    mockHosts([
      [DOMESTIC, () => catalogRes(401)],
      [GLOBAL, () => ({ ...catalogRes(429), headers: new Headers({ 'Retry-After': '3' }) }) as Response],
    ]);
    await expect(provider.validateKey('limited-key')).rejects.toMatchObject({ status: 429, retryAfterMs: 3000 });
  });

  it('streams a global key through the global host too', async () => {
    const provider = new ZhipuProvider();
    const urls = mockHosts([
      [DOMESTIC, () => catalogRes(401)],
      [GLOBAL, () => catalogRes(200)],
    ]);
    await provider.validateKey('zai-key');

    const sse = [
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"glm-4.5-flash","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"glm-4.5-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    vi.spyOn(global, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      urls.push(String(url));
      return {
        ok: true, status: 200, headers: new Headers(),
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
          },
        }),
      } as unknown as Response;
    }) as typeof fetch);

    for await (const _ of provider.streamChatCompletion('zai-key', [{ role: 'user', content: 'hi' }], 'glm-4.5-flash')) {
      // drain
    }
    expect(urls.at(-1)).toBe(`${GLOBAL}/chat/completions`);
  });

  it('caches per key — a domestic key is unaffected by a global one', async () => {
    const provider = new ZhipuProvider();
    // Only 'zai-key' gets a cache entry; 'cn-key' is never validated here, so
    // it must still take the pinned domestic default.
    const urls = mockHosts([
      [DOMESTIC, () => catalogRes(401)],
      [GLOBAL, () => catalogRes(200)],
    ]);
    await provider.validateKey('zai-key');

    vi.spyOn(global, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      urls.push(String(url));
      return chatRes();
    }) as typeof fetch);

    await provider.chatCompletion('cn-key', [{ role: 'user', content: 'hi' }], 'glm-4.5-flash');
    expect(urls.at(-1)).toBe(`${DOMESTIC}/chat/completions`);

    await provider.chatCompletion('zai-key', [{ role: 'user', content: 'hi' }], 'glm-4.5-flash');
    expect(urls.at(-1)).toBe(`${GLOBAL}/chat/completions`);
  });

  it('reports the domestic failure when both consoles reject the key', async () => {
    const provider = new ZhipuProvider();
    mockHosts([
      [DOMESTIC, () => catalogRes(401, 'domestic says no')],
      [GLOBAL, () => catalogRes(401, 'global says no')],
    ]);

    const result = await provider.validateKey('bad-key');
    expect(result).not.toBe(true);
    expect((result as { valid: false; error: string }).error).toContain('domestic says no');
  });

  it('reports the domestic rejection when the global host is unreachable', async () => {
    const provider = new ZhipuProvider();
    mockHosts([
      [DOMESTIC, () => catalogRes(401, 'domestic says no')],
      [GLOBAL, () => { throw new Error('ENETUNREACH'); }],
    ]);

    // An unreachable api.z.ai must not turn a plainly invalid key into a
    // transport error — the domestic verdict still stands.
    const result = await provider.validateKey('bad-key');
    expect(result).not.toBe(true);
    expect((result as { valid: false; error: string }).error).toContain('domestic says no');
  });

  it('re-checks from the domestic default when a key is validated again', async () => {
    const provider = new ZhipuProvider();
    const urls = mockHosts([
      [DOMESTIC, () => catalogRes(401)],
      [GLOBAL, () => catalogRes(200)],
    ]);
    await provider.validateKey('key');
    urls.length = 0;

    // The cached global verdict must not make the second validation skip the
    // domestic probe — a key can be swapped in place for a domestic one.
    await provider.validateKey('key');
    expect(urls[0]).toBe(`${DOMESTIC}/models`);
  });

  it('registers under the zhipu platform with the Zhipu AI display name', () => {
    const provider = new ZhipuProvider({ timeoutMs: 60_000 });
    expect(provider.platform).toBe('zhipu');
    expect(provider.name).toBe('Zhipu AI');
    expect(provider.modelsUrl).toBe(`${DOMESTIC}/models`);
  });
});
