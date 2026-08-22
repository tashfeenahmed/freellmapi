import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProxyBypass,
  applyProxyEnabled,
  applyProxyMode,
  applyProxyUrl,
  FETCH_RELAY_TARGET_HEADER,
  probeProxyUrl,
  proxyFetch,
} from '../../lib/proxy.js';

describe('fetch-relay transport', () => {
  beforeEach(() => {
    for (const name of ['PROXY_MODE', 'PROXY_URL', 'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
      delete process.env[name];
      delete process.env[name.toLowerCase()];
    }
    applyProxyEnabled(true);
    applyProxyBypass('');
    applyProxyUrl('https://relay.example.test/secret');
    applyProxyMode('fetch-relay');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    applyProxyMode('forward');
    applyProxyUrl('');
  });

  it('preserves method, authorization, body and signal with the target in a header', async () => {
    const signal = AbortSignal.timeout(5_000);
    const response = new Response('{"ok":true}', { status: 201 });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(response);

    const result = await proxyFetch('https://api.provider.test/v1/chat?trace=secret', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer provider-key',
        'Content-Type': 'application/json',
        Host: 'api.provider.test',
        'Content-Length': '17',
      },
      body: '{"hello":"world"}',
      signal,
    }, 'groq');

    expect(result).toBe(response);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [destination, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(destination).toBe('https://relay.example.test/secret');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"hello":"world"}');
    expect(init.signal).toBe(signal);
    expect(init.redirect).toBe('manual');
    expect(headers.get('authorization')).toBe('Bearer provider-key');
    expect(headers.get(FETCH_RELAY_TARGET_HEADER)).toBe('https://api.provider.test/v1/chat?trace=secret');
    expect(headers.has('host')).toBe(false);
    expect(headers.has('content-length')).toBe(false);
  });

  it('supports the encoded {url} compatibility template without adding the target header', async () => {
    applyProxyUrl('https://relay.example.test/fetch?url={url}');
    applyProxyMode('fetch-relay');
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));

    await proxyFetch('https://api.provider.test/v1/models?a=1&b=two words', undefined, 'groq');

    const [destination, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(destination).toBe(
      'https://relay.example.test/fetch?url=https%3A%2F%2Fapi.provider.test%2Fv1%2Fmodels%3Fa%3D1%26b%3Dtwo%20words',
    );
    expect(new Headers(init.headers).has(FETCH_RELAY_TARGET_HEADER)).toBe(false);
  });

  it('returns the relay Response body untouched so SSE can stream incrementally', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      },
    });
    const response = new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    vi.spyOn(global, 'fetch').mockResolvedValue(response);

    const result = await proxyFetch('https://api.provider.test/v1/chat', undefined, 'groq');
    expect(result).toBe(response);
    const first = await result.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
  });

  it('keeps redirect handling manual so a relay redirect cannot become a direct request', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://api.provider.test/v1/models' },
    }));

    const result = await proxyFetch('https://api.provider.test/v1/models', undefined, 'groq');

    expect(result.status).toBe(302);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect((fetchSpy.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
  });

  it('bypasses the relay when disabled or when the platform is exempt', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));

    applyProxyEnabled(false);
    await proxyFetch('https://api.provider.test/disabled', undefined, 'groq');
    applyProxyEnabled(true);
    applyProxyBypass('groq');
    await proxyFetch('https://api.provider.test/bypassed', undefined, 'groq');

    expect(fetchSpy.mock.calls.map(call => call[0])).toEqual([
      'https://api.provider.test/disabled',
      'https://api.provider.test/bypassed',
    ]);
  });

  it('uses the draft relay mode and URL for connectivity probes', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const result = await probeProxyUrl('https://draft-relay.example.test/secret', {
      mode: 'fetch-relay',
      targetUrl: 'https://api.provider.test/v1/models',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(401);
    const [destination, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(destination).toBe('https://draft-relay.example.test/secret');
    expect(new Headers(init.headers).get(FETCH_RELAY_TARGET_HEADER)).toBe('https://api.provider.test/v1/models');
  });

  it('propagates AbortSignal cancellation to the relay fetch', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = proxyFetch('https://api.provider.test/v1/chat', { signal: controller.signal }, 'groq', 'chat', 1_000);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
