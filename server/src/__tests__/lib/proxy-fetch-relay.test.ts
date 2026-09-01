import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProxyBypass,
  applyProxyEnabled,
  applyProxyMode,
  applyProxyUrl,
  applyFetchRelayToken,
  FETCH_RELAY_AUTH_HEADER,
  FETCH_RELAY_TARGET_HEADER,
  getProxyMode,
  probeProxyUrl,
  proxyFetch,
} from '../../lib/proxy.js';

describe('fetch-relay transport', () => {
  beforeEach(() => {
    for (const name of ['PROXY_MODE', 'PROXY_URL', 'FETCH_RELAY_TOKEN', 'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
      delete process.env[name];
      delete process.env[name.toLowerCase()];
    }
    applyProxyEnabled(true);
    applyProxyBypass('');
    applyProxyUrl('https://relay.example.test/secret');
    applyProxyMode('fetch-relay');
    applyFetchRelayToken('relay-secret');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    applyProxyMode('forward');
    applyProxyUrl('');
    applyFetchRelayToken('');
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
    expect(headers.get(FETCH_RELAY_AUTH_HEADER)).toBe('Bearer relay-secret');
    expect(headers.has('host')).toBe(false);
    expect(headers.has('content-length')).toBe(false);
  });

  it('overwrites caller-supplied Relay control headers', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));

    await proxyFetch('https://api.provider.test/v1/models?a=1&b=two words', {
      headers: {
        [FETCH_RELAY_TARGET_HEADER]: 'https://attacker.test',
        [FETCH_RELAY_AUTH_HEADER]: 'Bearer attacker-token',
      },
    }, 'groq');

    const [destination, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(destination).toBe('https://relay.example.test/secret');
    const headers = new Headers(init.headers);
    expect(headers.get(FETCH_RELAY_TARGET_HEADER)).toBe('https://api.provider.test/v1/models?a=1&b=two words');
    expect(headers.get(FETCH_RELAY_AUTH_HEADER)).toBe('Bearer relay-secret');
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
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await probeProxyUrl('https://draft-relay.example.test/secret', {
      mode: 'fetch-relay',
      targetUrl: 'https://api.provider.test/v1/models',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    const [destination, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(destination).toBe('https://draft-relay.example.test/secret');
    expect(new Headers(init.headers).get(FETCH_RELAY_TARGET_HEADER)).toBe('https://api.provider.test/v1/models');
    expect(new Headers(init.headers).get(FETCH_RELAY_AUTH_HEADER)).toBe('Bearer relay-secret');
  });

  // A forward proxy answers the CONNECT separately from the upstream, so a 401
  // there really is the provider talking. A relay answers on the same
  // connection it forwards over, so a 401/403 is the relay refusing our token
  // far more often than not. Calling that a pass is exactly how a bad token
  // reads as a working relay.
  it.each([401, 403])('fails the probe when the relay rejects the token (%i)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('unauthorized', { status }));

    const result = await probeProxyUrl('https://draft-relay.example.test/secret', {
      mode: 'fetch-relay',
      targetUrl: 'https://api.provider.test/v1/models',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(status);
    expect(result.error).toBe(`relay rejected the token (${status})`);
  });

  it('still passes the probe on a forward-proxy 401, which is the upstream talking', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const result = await probeProxyUrl('http://proxy.corp.test:8080', {
      mode: 'forward',
      targetUrl: 'https://api.provider.test/v1/models',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(401);
  });

  // socks5:// cannot carry an application-layer relay request at all, so
  // keeping the mode would fail every provider call at runtime with an opaque
  // error. Boot degrades it to the forward proxy such a URL always was.
  it('falls back to forward when PROXY_MODE names a relay a SOCKS URL cannot serve', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.PROXY_MODE = 'fetch-relay';
    process.env.PROXY_URL = 'socks5h://127.0.0.1:1080';

    applyProxyUrl('');
    applyProxyMode('fetch-relay');

    expect(getProxyMode()).toBe('forward');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/needs an http\(s\) relay URL/);
    delete process.env.PROXY_MODE;
    delete process.env.PROXY_URL;
  });

  it('keeps a plaintext remote relay working but warns that it leaks the keys it carries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.PROXY_MODE = 'fetch-relay';
    process.env.PROXY_URL = 'http://relay.example.test';

    applyProxyUrl('');
    applyProxyMode('fetch-relay');

    expect(getProxyMode()).toBe('fetch-relay');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/must use https/);
    delete process.env.PROXY_MODE;
    delete process.env.PROXY_URL;
  });

  it('accepts a loopback plaintext relay without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.PROXY_MODE = 'fetch-relay';
    process.env.PROXY_URL = 'http://127.0.0.1:8787';

    applyProxyUrl('');
    applyProxyMode('fetch-relay');

    expect(getProxyMode()).toBe('fetch-relay');
    expect(warn).not.toHaveBeenCalled();
    delete process.env.PROXY_MODE;
    delete process.env.PROXY_URL;
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
