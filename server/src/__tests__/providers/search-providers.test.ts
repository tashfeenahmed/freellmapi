import { describe, it, expect, afterEach, vi } from 'vitest';
import { TavilyProvider } from '../../providers/tavily.js';
import { ExaProvider } from '../../providers/exa.js';
import { FirecrawlProvider } from '../../providers/firecrawl.js';
import { LinkupProvider } from '../../providers/linkup.js';
import { ParallelProvider } from '../../providers/parallel.js';
import { KeenableProvider } from '../../providers/keenable.js';
import { getProvider } from '../../providers/index.js';

// Search platforms (#1174) validate keys without spending search credits and
// refuse chat outright.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function respond(status: number) {
  const fn = vi.fn(() => Promise.resolve(new Response('{}', { status })));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const cases = [
  { provider: new TavilyProvider(), url: 'https://api.tavily.com/usage', method: 'GET' },
  { provider: new ExaProvider(), url: 'https://api.exa.ai/search', method: 'POST' },
  { provider: new FirecrawlProvider(), url: 'https://api.firecrawl.dev/v2/team/credit-usage', method: 'GET' },
  { provider: new LinkupProvider(), url: 'https://api.linkup.so/v1/credits/balance', method: 'GET' },
  { provider: new ParallelProvider(), url: 'https://api.parallel.ai/v1/search', method: 'POST' },
  { provider: new KeenableProvider(), url: 'https://api.keenable.ai/v1/search', method: 'POST' },
];

describe.each(cases)('$provider.name key validation', ({ provider, url, method }) => {
  it('probes a no-cost endpoint', async () => {
    const fn = respond(200);
    expect(await provider.validateKey('k')).toBe(true);
    const [calledUrl, init] = (fn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe(method);
  });

  it('treats 401 as an invalid key', async () => {
    respond(401);
    expect(await provider.validateKey('k')).toMatchObject({ valid: false });
  });

  it('treats other 4xx (empty probe body, spent credits) as authenticated', async () => {
    respond(400);
    expect(await provider.validateKey('k')).toBe(true);
  });

  it('reports 5xx as inconclusive by throwing, never as an invalid key', async () => {
    // #1717: a returned {valid:false} is persisted as status='invalid', and
    // disabled keys are skipped by later health passes, so a 5xx used to bench
    // a working key permanently. Inconclusive cases must throw (#1298).
    respond(503);
    await expect(provider.validateKey('k')).rejects.toThrow(/inconclusive/i);
  });

  it('reports a probe timeout as inconclusive by throwing (#1717)', async () => {
    // The reported case: a search key whose 10 s probe timed out was marked
    // invalid and disabled 15 minutes after it was healthy.
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    await expect(provider.validateKey('k')).rejects.toThrow(/inconclusive/i);
  });

  it('refuses chat completions with a 422', async () => {
    await expect(provider.chatCompletion('k', [], 'm')).rejects.toMatchObject({ status: 422 });
  });
});

describe('Parallel keyless validation', () => {
  it('is keyless', () => {
    expect(new ParallelProvider().keyless).toBe(true);
  });

  it('checks the stored sentinel with an MCP initialize, sending no key', async () => {
    const fn = respond(200);
    expect(await new ParallelProvider().validateKey('no-key')).toBe(true);
    const [calledUrl, init] = (fn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(calledUrl).toBe('https://search.parallel.ai/mcp');
    expect(JSON.parse(init.body as string)).toMatchObject({ method: 'initialize' });
    expect((init.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('sends a real key as x-api-key with an empty body, which spends nothing', async () => {
    const fn = respond(422);
    expect(await new ParallelProvider().validateKey(' real-key ')).toBe(true);
    const [, init] = (fn.mock.calls as unknown as [string, RequestInit][])[0];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('real-key');
    expect(init.body).toBe('{}');
  });
});

describe('Keenable keyless validation', () => {
  it('is keyless', () => {
    expect(new KeenableProvider().keyless).toBe(true);
  });

  it('checks the stored sentinel on the public endpoint with the app title, sending no key', async () => {
    const fn = respond(400);
    expect(await new KeenableProvider().validateKey('no-key')).toBe(true);
    const [calledUrl, init] = (fn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(calledUrl).toBe('https://api.keenable.ai/v1/search/public');
    expect((init.headers as Record<string, string>)['X-Keenable-Title']).toBe('freellmapi');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBeUndefined();
    expect(init.body).toBe('{}');
  });

  it('sends a real key as X-API-Key with an empty body, which runs no search', async () => {
    const fn = respond(400);
    expect(await new KeenableProvider().validateKey(' real-key ')).toBe(true);
    const [calledUrl, init] = (fn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(calledUrl).toBe('https://api.keenable.ai/v1/search');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('real-key');
    expect(init.body).toBe('{}');
  });
});

describe('registry', () => {
  it('registers every search platform', () => {
    for (const p of ['tavily', 'exa', 'firecrawl', 'linkup', 'parallel', 'keenable'] as const) expect(getProvider(p)?.platform).toBe(p);
  });
});
