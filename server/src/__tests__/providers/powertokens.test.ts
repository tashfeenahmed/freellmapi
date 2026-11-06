import { describe, expect, it } from 'vitest';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform } from '../../lib/key-parser.js';

describe('PowerTokens provider registration', () => {
  it('registers as an OpenAI-compatible provider', () => {
    const provider = getProvider('powertokens');
    expect(provider).toBeDefined();
    expect(provider!.platform).toBe('powertokens');
  });

  it('points at the documented OpenAI-compatible base URL', () => {
    const provider = getProvider('powertokens') as unknown as { baseUrl: string; timeoutMs?: number };
    expect(provider.baseUrl).toBe('https://api.powertokens.ai/v1');
  });

  it('uses a 60s timeout for glm-4.7-flash hidden reasoning', () => {
    const provider = getProvider('powertokens') as unknown as { timeoutMs: number };
    expect(provider.timeoutMs).toBe(60_000);
  });

  it('resolves from .env prefixes', () => {
    for (const prefix of ['POWERTOKENS_', 'POWER_TOKENS_', 'PT_']) {
      expect(detectPlatform(prefix)).toBe('powertokens');
    }
  });

  it('resolves from auth.json aliases', () => {
    for (const alias of ['powertokens', 'power-tokens', 'pt']) {
      expect(AUTH_JSON_PROVIDER_MAP[alias]).toBe('powertokens');
    }
  });
});
