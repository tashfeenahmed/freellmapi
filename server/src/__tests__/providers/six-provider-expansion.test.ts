import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider, hasProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';

afterEach(() => vi.restoreAllMocks());

describe('six-provider expansion registry', () => {
  it.each([
    ['tokenreply', ['TOKENREPLY_', 'TOKEN_REPLY_'], ['tokenreply', 'token-reply']],
    ['mnn', ['MNN_'], ['mnn', 'mnn-ai']],
    ['fishaudio', ['FISHAUDIO_', 'FISH_AUDIO_'], ['fishaudio', 'fish-audio']],
    ['cartesia', ['CARTESIA_'], ['cartesia']],
    ['tinyfish', ['TINYFISH_'], ['tinyfish']],
  ] as const)('registers %s with key import and an account-wide quota pool', (platform, prefixes, aliases) => {
    expect(hasProvider(platform)).toBe(true);
    for (const prefix of prefixes) expect(detectPlatform(prefix)).toBe(platform);
    for (const alias of aliases) expect(AUTH_JSON_PROVIDER_MAP[alias]).toBe(platform);
    expect(inferPoolForPlatform(platform, 'model-a')).toBe(inferPoolForPlatform(platform, 'model-b'));
  });

  it('does not probe MNN public model metadata as proof that a key is valid', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const provider = getProvider('mnn')!;
    expect(provider.supportsKeyValidation).toBe(false);
    await expect(provider.validateKey('bad-key')).rejects.toThrow('key validity is unknown');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates Cartesia with its authenticated, read-only model endpoint', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [] }));
    await expect(getProvider('cartesia')!.validateKey('test-key')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.cartesia.ai/models');
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('cartesia-version')).toBe('2026-08-14');
  });

  it('routes TokenReply through its OpenAI-compatible base URL without rewriting the selected model', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      id: 'test', object: 'chat.completion', created: 1, model: 'beam-free',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    }));
    const result = await getProvider('tokenreply')!.chatCompletion('test-key', [{ role: 'user', content: 'Return JSON' }], 'beam-free', {
      response_format: { type: 'json_object' }, max_tokens: 16,
    });
    expect(fetch.mock.calls[0][0]).toBe('https://api.tokenreply.com/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: 'beam-free', response_format: { type: 'json_object' } });
    expect(result.model).toBe('beam-free');
  });

  it.each(['fishaudio', 'cartesia', 'tinyfish'] as const)('%s refuses chat requests because it is a media/search API', async platform => {
    await expect(getProvider(platform)!.chatCompletion('test-key', [], 'model')).rejects.toMatchObject({ status: 422 });
  });
});
