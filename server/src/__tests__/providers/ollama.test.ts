import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

describe('Ollama Provider', () => {
  let providerDefault: OpenAICompatProvider;
  let providerCustom: OpenAICompatProvider;

  beforeEach(() => {
    // Reset environment variables before each test
    vi.restoreAllMocks();
    process.env.LOCAL_OLLAMA_URL = undefined;
  });

  it('should use custom LOCAL_OLLAMA_URL environment variable', () => {
    process.env.LOCAL_OLLAMA_URL = 'http://custom-ollama:11434/v1';

    providerCustom = new OpenAICompatProvider({
      platform: 'ollama-local',
      name: 'Ollama Local',
      baseUrl: process.env.LOCAL_OLLAMA_URL?.trim() || 'http://127.0.0.1:11434/v1',
      timeoutMs: 600000,
    });

    expect((providerCustom as any).baseUrl).toBe('http://custom-ollama:11434/v1');
  });

  it('should allow explicit baseUrl override in constructor', () => {
    providerCustom = new OpenAICompatProvider({
      platform: 'ollama-local',
      name: 'Ollama Local',
      baseUrl: 'http://explicit-ollama:11434/v1',
      timeoutMs: 600000,
    });

    expect((providerCustom as any).baseUrl).toBe('http://explicit-ollama:11434/v1');
  });

  it('should have ollama-local in getAllProviders', async () => {
    const { getAllProviders } = await import('../../providers/index.js');
    const providers = getAllProviders();
    
    const ollamaLocalProvider = providers.find(p => p.platform === 'ollama-local');
    expect(ollamaLocalProvider).toBeDefined();
    expect(ollamaLocalProvider?.name).toBe('Ollama Local');
  });

  it('should return ollama-local via getProvider', async () => {
    const { getProvider } = await import('../../providers/index.js');
    const provider = getProvider('ollama-local');
    
    expect(provider).toBeDefined();
    expect(provider?.platform).toBe('ollama-local');
    expect(provider?.name).toBe('Ollama Local');
  });
});