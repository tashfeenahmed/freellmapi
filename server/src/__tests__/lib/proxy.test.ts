import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyProxyUrl,
  applyProxyEnabled,
  applyProxyBypass,
  getProxyUrl,
  isProxyEnabled,
  getProxyBypassPlatforms,
  isProxyActive,
  proxyFetch,
} from '../../lib/proxy.js';

// Reset module-level proxy state before each test so cases don't bleed into
// each other (the lib keeps a process-wide config + a short dispatcher cache).
beforeEach(() => {
  delete process.env.PROXY_URL;
  applyProxyEnabled(true);
  applyProxyBypass('');
  applyProxyUrl(''); // clears the URL and the dispatcher cache
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PROXY_URL;
});

const okResponse = () => ({ ok: true, status: 200 }) as Response;

describe('proxy config accessors', () => {
  it('PROXY_URL env wins over the DB value', () => {
    process.env.PROXY_URL = 'http://env-proxy:8080';
    applyProxyUrl('http://db-proxy:3128');
    expect(getProxyUrl()).toBe('http://env-proxy:8080');
  });

  it('falls back to the DB value when no env var is set', () => {
    applyProxyUrl('http://db-proxy:3128');
    expect(getProxyUrl()).toBe('http://db-proxy:3128');
  });

  it('parses the comma-separated bypass list', () => {
    applyProxyBypass('groq, Google ,, cerebras');
    expect(getProxyBypassPlatforms().sort()).toEqual(['cerebras', 'google', 'groq']);
  });

  it('isProxyActive is false when no proxy URL is configured', () => {
    expect(isProxyActive()).toBe(false);
  });

  it('isProxyActive is true when an HTTP proxy is configured and enabled', () => {
    applyProxyUrl('http://proxy:8080');
    expect(isProxyActive()).toBe(true);
  });

  it('isProxyActive is false when a proxy is configured but disabled', () => {
    applyProxyUrl('http://proxy:8080');
    applyProxyEnabled(false);
    expect(isProxyEnabled()).toBe(false);
    expect(isProxyActive()).toBe(false);
  });
});

describe('proxyFetch routing', () => {
  it('passes straight through to fetch when no proxy is configured (default for all users)', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch('https://api.example.com/v1', { method: 'POST' });
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0];
    // No dispatcher injected on the direct path.
    expect((init as any)?.dispatcher).toBeUndefined();
  });

  it('routes through the dispatcher for an HTTP proxy', async () => {
    applyProxyUrl('http://proxy:8080');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq');
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0];
    expect((init as any)?.dispatcher).toBeDefined();
  });

  it('bypasses the proxy for a platform on the bypass list', async () => {
    applyProxyUrl('http://proxy:8080');
    applyProxyBypass('groq');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch('https://api.example.com/v1', { method: 'POST' }, 'groq');
    const [, init] = spy.mock.calls[0];
    expect((init as any)?.dispatcher).toBeUndefined(); // direct, not proxied
  });

  it('bypasses the proxy globally when disabled', async () => {
    applyProxyUrl('http://proxy:8080');
    applyProxyEnabled(false);
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse());
    await proxyFetch('https://api.example.com/v1', undefined, 'google');
    const [, init] = spy.mock.calls[0];
    expect((init as any)?.dispatcher).toBeUndefined();
  });
});
