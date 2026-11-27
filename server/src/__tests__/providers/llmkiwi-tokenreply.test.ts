import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from '../../providers/index.js';
import { LlmKiwiProvider } from '../../providers/llmkiwi.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform } from '../../lib/key-parser.js';
import { inferQuotaPoolKey } from '../../services/provider-quota.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function respond(status: number, body: unknown = {}) {
  const fn = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('LLM.kiwi provider', () => {
  it('registers at the documented base URL', () => {
    const provider = getProvider('llmkiwi') as unknown as { platform: string; baseUrl: string };
    expect(provider.platform).toBe('llmkiwi');
    expect(provider.baseUrl).toBe('https://api.llm.kiwi/v1');
  });

  it('checks a key with an empty chat request, never with the public /models list', async () => {
    const fn = respond(400, { error: { code: 'missing_messages' } });
    expect(await new LlmKiwiProvider().validateKey('sk_kiwi_good')).toBe(true);
    const [url, init] = (fn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('https://api.llm.kiwi/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk_kiwi_good');
  });

  it('reads 401 as an invalid key', async () => {
    respond(401, { error: { code: 'invalid_api_key', message: 'Invalid or revoked API key.' } });
    expect(await new LlmKiwiProvider().validateKey('sk_kiwi_bad')).toMatchObject({ valid: false });
  });

  it('throws on anything else, so health never disables a key it could not check', async () => {
    respond(503);
    await expect(new LlmKiwiProvider().validateKey('k')).rejects.toThrow(/inconclusive/i);
    respond(200, { choices: [] });
    await expect(new LlmKiwiProvider().validateKey('k')).rejects.toThrow(/inconclusive/i);
  });

  it('sends the malformed check once per key, not on every health pass', () => {
    expect(new LlmKiwiProvider().supportsKeyPolling).toBe(false);
  });

  it('shares one account rate window across its models', () => {
    expect(inferQuotaPoolKey('llmkiwi', 'auto')).toBe('llmkiwi::account');
    expect(inferQuotaPoolKey('llmkiwi', 'hrllm')).toBe('llmkiwi::account');
  });
});

describe('TokenReply provider', () => {
  it('registers at the documented base URL with a 60s timeout', () => {
    const provider = getProvider('tokenreply') as unknown as { platform: string; baseUrl: string; timeoutMs: number };
    expect(provider.platform).toBe('tokenreply');
    expect(provider.baseUrl).toBe('https://api.tokenreply.com/v1');
    expect(provider.timeoutMs).toBe(60_000);
  });

  it('checks a key against /models, which answers 401 for a bad key', async () => {
    const fn = respond(401, { error: { message: 'invalid token' } });
    expect(await getProvider('tokenreply')!.validateKey('sk-bad')).toMatchObject({ valid: false });
    expect((fn.mock.calls as unknown as [string][])[0][0]).toBe('https://api.tokenreply.com/v1/models');
  });

  it('keeps a separate quota pool per model (free routes come from different upstreams)', () => {
    expect(inferQuotaPoolKey('tokenreply', 'mimo-v2.6-flash-free')).not.toBe(inferQuotaPoolKey('tokenreply', 'nemotron-3.5-super-vl-free'));
  });
});

describe('key import aliases', () => {
  it('resolves .env prefixes', () => {
    expect(detectPlatform('LLMKIWI_')).toBe('llmkiwi');
    expect(detectPlatform('LLM_KIWI_')).toBe('llmkiwi');
    expect(detectPlatform('TOKENREPLY_')).toBe('tokenreply');
    expect(detectPlatform('TOKEN_REPLY_')).toBe('tokenreply');
    expect(detectPlatform('TINYFISH_')).toBe('tinyfish');
  });

  it('resolves auth.json aliases', () => {
    expect(AUTH_JSON_PROVIDER_MAP['llm.kiwi']).toBe('llmkiwi');
    expect(AUTH_JSON_PROVIDER_MAP.llmkiwi).toBe('llmkiwi');
    expect(AUTH_JSON_PROVIDER_MAP['tokenreply.com']).toBe('tokenreply');
    expect(AUTH_JSON_PROVIDER_MAP.tokenreply).toBe('tokenreply');
    expect(AUTH_JSON_PROVIDER_MAP.tinyfish).toBe('tinyfish');
  });
});
