import { describe, expect, it } from 'vitest';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform } from '../../lib/key-parser.js';

describe('cheapllm.shop provider registration', () => {
  it('registers as an OpenAI-compatible provider', () => {
    const provider = getProvider('cheapllm');
    expect(provider).toBeDefined();
    expect(provider!.platform).toBe('cheapllm');
  });

  it('points at the documented OpenAI-compatible base URL', () => {
    const provider = getProvider('cheapllm') as unknown as { baseUrl: string };
    expect(provider.baseUrl).toBe('https://cheapllm.shop/v1');
  });

  it('allows 180s because requests queue when busy and the model reasons first', () => {
    const provider = getProvider('cheapllm') as unknown as { timeoutMs: number };
    expect(provider.timeoutMs).toBe(180_000);
  });

  it('resolves from the .env prefix', () => {
    expect(detectPlatform('CHEAPLLM_')).toBe('cheapllm');
  });

  it('resolves from auth.json aliases', () => {
    for (const alias of ['cheapllm', 'cheapllm.shop']) {
      expect(AUTH_JSON_PROVIDER_MAP[alias]).toBe('cheapllm');
    }
  });
});
