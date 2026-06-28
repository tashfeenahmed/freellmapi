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
  describeAbort,
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

// Compact abort-error triage tag formatting. The string written to
// `requests.error` is `The operation was aborted (<platform>, <type>, <N>s)`
// — round-trip what's already on the row so an operator can read the abort
// cause without joining against the columns.
describe('describeAbort', () => {
  it('formats platform + type + timeout-in-seconds', () => {
    expect(describeAbort('cloudflare', 'chat', 15_000)).toBe('cloudflare, chat, 15s');
    expect(describeAbort('opencode', 'embedding', 30_000)).toBe('opencode, embedding, 30s');
    expect(describeAbort('nvidia', 'image', 60_000)).toBe('nvidia, image, 60s');
    expect(describeAbort('google', 'audio', 60_000)).toBe('google, audio, 60s');
  });

  it('rounds sub-second milliseconds up to 1s (no "0s")', () => {
    expect(describeAbort('x', 'chat', 500)).toBe('x, chat, 1s');
    expect(describeAbort('x', 'chat', 0)).toBe('x, chat');
  });

  it('falls back to "unknown" when platform or type is missing', () => {
    expect(describeAbort(undefined, 'chat', 15_000)).toBe('unknown, chat, 15s');
    expect(describeAbort('  ', 'chat', 15_000)).toBe('unknown, chat, 15s');
    expect(describeAbort('cloudflare', 'unknown', 15_000)).toBe('cloudflare, unknown, 15s');
  });

  it('omits the timeout suffix when no timeout is provided', () => {
    expect(describeAbort('cloudflare', 'chat', undefined)).toBe('cloudflare, chat');
    expect(describeAbort('cloudflare', 'chat', 0)).toBe('cloudflare, chat');
  });
});

// Regression: previously every abort through proxyFetch surfaced as the bare
// string "The operation was aborted" with no upstream URL or platform context.
// The fix wraps proxyFetch's catch with an enrichAbort() that rewrites the
// DOMException message to `The operation was aborted (<platform>, <type>, <N>s)`
// — no URL, no credentials — so an operator reading the requests.error column
// gets the same triage info as the requests row columns (platform, request_type,
// latency_ms / timeout). The `name: 'AbortError'` is preserved so
// isRetryableError() (which matches the substring "aborted") keeps
// classifying it as retryable.
describe('proxyFetch abort error enrichment', () => {
  it('rewrites a native AbortError to include platform, type, and timeout', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    vi.spyOn(global, 'fetch').mockRejectedValue(abortErr);
    await expect(
      proxyFetch('https://api.openrouter.ai/api/v1/chat/completions', undefined, 'openrouter', 'chat', 15_000),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('openrouter, chat, 15s'),
    });
  });

  it('does not include any URL or path in the enriched message', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    vi.spyOn(global, 'fetch').mockRejectedValue(abortErr);
    let caught: Error | null = null;
    try {
      await proxyFetch(
        'https://api.openrouter.ai/api/v1/chat/completions',
        undefined,
        'openrouter',
        'chat',
        15_000,
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain('api.openrouter.ai');
    expect(caught!.message).not.toContain('/v1/chat/completions');
  });

  it('omits the timeout suffix when none was supplied (older call sites)', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    vi.spyOn(global, 'fetch').mockRejectedValue(abortErr);
    await expect(
      proxyFetch('https://api.example.com/v1', undefined, 'groq', 'chat'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('groq, chat)'),
    });
  });

  it('does not rewrite non-AbortError rejections', async () => {
    const typeErr = new TypeError('fetch failed');
    vi.spyOn(global, 'fetch').mockRejectedValue(typeErr);
    await expect(
      proxyFetch('https://api.example.com/v1', undefined, 'groq', 'chat', 15_000),
    ).rejects.toBe(typeErr);
  });
});
