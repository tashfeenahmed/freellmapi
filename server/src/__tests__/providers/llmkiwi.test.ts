import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';

afterEach(() => vi.restoreAllMocks());

describe('LLM.kiwi entry points', () => {
  it.each([
    { platform: 'llmkiwi' as const, prefixes: ['LLMKIWI_', 'LLM_KIWI_'], aliases: ['llmkiwi', 'llm-kiwi'] },
  ])('registers $platform consistently and shares account quota across models', ({ platform, prefixes, aliases }) => {
    expect(getProvider(platform)?.keyless).toBe(false);
    for (const prefix of prefixes) expect(detectPlatform(prefix)).toBe(platform);
    for (const alias of aliases) expect(AUTH_JSON_PROVIDER_MAP[alias]).toBe(platform);
    expect(inferPoolForPlatform(platform, 'one')).toBe(inferPoolForPlatform(platform, 'two'));
  });

  it('does not mistake the public Kiwi catalog for credential validation or spend probe tokens', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    const provider = getProvider('llmkiwi')!;
    expect(provider.supportsKeyValidation).toBe(false);
    await expect(provider.validateKey('invalid-key')).rejects.toThrow('key validity is unknown');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.each([
  { platform: 'llmkiwi' as const, base: 'https://api.llm.kiwi/v1', model: 'auto' },
])('$platform inference transport', ({ platform, base, model }) => {
  it('sends bearer auth, the exact model, and normalizes the completion', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({
      id: 'test', object: 'chat.completion', created: 1, model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
    const result = await getProvider(platform)!.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model, { max_tokens: 8 });
    expect(fetch.mock.calls[0][0]).toBe(`${base}/chat/completions`);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 8 });
    expect(result.choices[0].message.content).toBe('OK');
    expect(result.usage?.total_tokens).toBe(3);
  });

  it('preserves streaming content and the terminal frame', async () => {
    const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] };
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`));
    const chunks = [];
    for await (const item of getProvider(platform)!.streamChatCompletion('test-key', [], model)) chunks.push(item);
    expect(chunks.map(item => item.choices[0]?.delta.content ?? '').join('')).toBe('OK');
  });
});
