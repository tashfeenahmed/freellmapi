import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import { getProvider, hasProvider } from '../../providers/index.js';
import { isRetryableError } from '../../lib/error-classify.js';

const gateways = [
  { platform: 'electronhub', base: 'https://api.electronhub.ai/v1', validate: 'https://api.electronhub.ai/v1/user/me' },
  { platform: 'experiential', base: 'https://api.experientiallabs.ai/v1', validate: 'https://api.experientiallabs.ai/v1/models' },
] as const;

function completion(content = 'OK') {
  return {
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'tested-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
  };
}

function stream(parts: string[]) {
  const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'tested-model' };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    ...parts.map(content => ({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })),
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('recurring-credit gateway adapters', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const gateway of gateways) {
    it(`${gateway.platform}: registers, authenticates, forwards the requested model and preserves usage`, async () => {
      expect(hasProvider(gateway.platform)).toBe(true);
      const provider = getProvider(gateway.platform)!;
      const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(completion())));
      const result = await provider.chatCompletion('test-key', [{ role: 'user', content: 'Reply OK' }], 'tested-model', {
        max_tokens: 256, temperature: 0.2,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      });
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(`${gateway.base}/chat/completions`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'tested-model', max_tokens: 256, temperature: 0.2 });
      expect(JSON.parse(String(init?.body)).tools[0].function.name).toBe('lookup');
      expect(result.choices[0].message.content).toBe('OK');
      expect(result.usage.total_tokens).toBe(10);
      expect(result._routed_via).toEqual({ platform: gateway.platform, model: 'tested-model' });
    });

    it(`${gateway.platform}: validates against an authenticated read-only endpoint`, async () => {
      const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
      await expect(getProvider(gateway.platform)!.validateKey('test-key')).resolves.toBe(true);
      expect(fetch.mock.calls[0][0]).toBe(gateway.validate);
      expect(fetch.mock.calls[0][1]?.method).toBe('GET');
      expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    });

    it.each([401, 403])(`${gateway.platform}: rejects an invalid credential (%s)`, async status => {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status }));
      await expect(getProvider(gateway.platform)!.validateKey('bad-test-key')).resolves.toMatchObject({ valid: false });
    });

    it(`${gateway.platform}: streams through the same endpoint with bearer auth`, async () => {
      const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(stream(['O', 'K']));
      const output: ChatCompletionChunk[] = [];
      for await (const chunk of getProvider(gateway.platform)!.streamChatCompletion('test-key', [{ role: 'user', content: 'Hi' }], 'tested-model')) output.push(chunk);
      expect(output.flatMap(chunk => chunk.choices).map(choice => choice.delta.content ?? '').join('')).toBe('OK');
      expect(fetch.mock.calls[0][0]).toBe(`${gateway.base}/chat/completions`);
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).stream).toBe(true);
      expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    });

    it(`${gateway.platform}: preserves provider-requested backoff`, async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), {
        status: 429, headers: { 'Retry-After': '180' },
      }));
      await expect(getProvider(gateway.platform)!.chatCompletion('test-key', [], 'tested-model')).rejects.toMatchObject({ status: 429, retryAfterMs: 180_000 });
    });
  }

  it('ElectronHub treats its HTTP-200 proxy-error banner as a retryable 502, without leaking the body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(completion('### **Proxy error (HTTP 404 Not Found)**\nPrivate upstream details'))));
    const error = await getProvider('electronhub')!.chatCompletion('test-key', [], 'tested-model').catch(e => e);
    expect(error.status).toBe(502);
    expect(isRetryableError(error)).toBe(true);
    expect(error.message).not.toContain('Private upstream');
  });

  it.each(['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4.7', 'claude-opus-4.8'])(
    'Experiential omits unsupported temperature and top_p for %s', async model => {
      const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(completion())));
      await getProvider('experiential')!.chatCompletion('test-key', [], model, { temperature: 0.7, top_p: 0.95, max_tokens: 256 });
      const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body.max_tokens).toBe(256);
    },
  );

  it('Experiential uses the same model-specific sampling policy while streaming', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(stream(['OK']));
    for await (const _chunk of getProvider('experiential')!.streamChatCompletion('test-key', [], 'claude-opus-5', { temperature: 0.7, top_p: 0.95 })) { /* drain */ }
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it.each(['claude-opus-4.6', 'claude-sonnet-4.6'])(
    'Experiential omits the restricted reasoning top_p for %s', async model => {
      const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(completion())));
      await getProvider('experiential')!.chatCompletion('test-key', [], model, { temperature: 0.7, top_p: 0.95 });
      const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
    },
  );

  it.each([
    [{ temperature: 0.7, top_p: 0.95 }, { temperature: 0.7 }],
    [{ top_p: 0.95 }, { top_p: 0.95 }],
  ])('Experiential never sends competing sampling knobs to legacy Claude routes', async (options, expected) => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(completion())));
    await getProvider('experiential')!.chatCompletion('test-key', [], 'claude-haiku-4.5', options);
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body).toMatchObject(expected);
    expect(body.temperature !== undefined && body.top_p !== undefined).toBe(false);
  });

  it('ElectronHub catches a proxy-error banner split across SSE chunks before yielding content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(['### **Pro', 'xy error (HTTP ', '404 Not Found)**']));
    const output: ChatCompletionChunk[] = [];
    const consume = async () => {
      for await (const chunk of getProvider('electronhub')!.streamChatCompletion('test-key', [], 'tested-model')) output.push(chunk);
    };
    await expect(consume()).rejects.toMatchObject({ status: 502 });
    expect(output).toEqual([]);
  });

  it('ElectronHub preserves normal markdown, including a short heading-prefix response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(['###']));
    const output: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('electronhub')!.streamChatCompletion('test-key', [], 'tested-model')) output.push(chunk);
    expect(output.flatMap(chunk => chunk.choices).map(choice => choice.delta.content ?? '').join('')).toBe('###');
  });
});
