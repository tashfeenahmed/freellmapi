import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatProvider, isAnonymousCredential } from '../../providers/openai-compat.js';

// #1331: a real API key saved on a keyless platform (Kilo, OVH) was silently
// routed over the anonymous path, and a custom endpoint stored with the
// `no-key` sentinel sent `Authorization: Bearer no-key` upstream — which
// upstreams read as an invalid key. The Authorization header must depend on
// the CREDENTIAL, not on the provider's keyless flag.
describe('keyless bearer handling (#1331)', () => {
  afterEach(() => vi.restoreAllMocks());

  function okFetch(capture: { headers?: Record<string, string> }): void {
    vi.spyOn(global, 'fetch').mockImplementation((async (_url: any, init: any) => {
      capture.headers = (init as any).headers;
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'x', object: 'chat.completion', created: 1, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        headers: new Headers(),
      };
    }) as any);
  }

  function keyless(platform: 'kilo' | 'ovh'): OpenAICompatProvider {
    return new OpenAICompatProvider({
      platform: platform as any, name: 'Keyless', baseUrl: 'https://x.test/v1', keyless: true,
    });
  }
  function custom(): OpenAICompatProvider {
    return new OpenAICompatProvider({
      platform: 'custom-endpoint' as any, name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1',
    });
  }

  const sentBearer = (h?: Record<string, string>) =>
    (h ?? {}).Authorization ?? (h ?? {}).authorization;

  it('keyless provider with a REAL key sends the bearer (was: anonymous)', async () => {
    const cap: { headers?: Record<string, string> } = {};
    okFetch(cap);
    await keyless('kilo').chatCompletion('real-kilo-key-123', [{ role: 'user', content: 'hi' }], 'm');
    expect(sentBearer(cap.headers)).toBe('Bearer real-kilo-key-123');
  });

  it('keyless provider with the no-key sentinel sends NO Authorization header', async () => {
    const cap: { headers?: Record<string, string> } = {};
    okFetch(cap);
    await keyless('kilo').chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'm');
    expect(sentBearer(cap.headers)).toBeUndefined();
  });

  it('custom endpoint with auth off (no-key sentinel) sends NO bearer', async () => {
    const cap: { headers?: Record<string, string> } = {};
    okFetch(cap);
    await custom().chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'm');
    expect(sentBearer(cap.headers)).toBeUndefined();
  });

  it('custom endpoint with a real key still sends the bearer', async () => {
    const cap: { headers?: Record<string, string> } = {};
    okFetch(cap);
    await custom().chatCompletion('sk-local-999', [{ role: 'user', content: 'hi' }], 'm');
    expect(sentBearer(cap.headers)).toBe('Bearer sk-local-999');
  });

  it('credential test is trimmed and covers empty/missing', () => {
    expect(isAnonymousCredential('  no-key  ')).toBe(true);
    expect(isAnonymousCredential('')).toBe(true);
    expect(isAnonymousCredential(undefined)).toBe(true);
    expect(isAnonymousCredential('sk-1')).toBe(false);
  });
});
