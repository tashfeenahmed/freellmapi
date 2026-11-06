import { describe, it, expect, vi } from 'vitest';
import { getProvider } from '../../providers/index.js';

describe('keyless decision providers', () => {
  it.each(['halx', 'aisense'] as const)('%s registers without a chat or inference health probe', async platform => {
    const provider = getProvider(platform)!;
    expect(provider.keyless).toBe(true);
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await provider.validateKey('no-key')).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      await expect(provider.chatCompletion('no-key', [], 'model')).rejects.toMatchObject({ status: 422 });
      await expect(provider.streamChatCompletion('no-key', [], 'model').next()).rejects.toMatchObject({ status: 422 });
    } finally { fetch.mockRestore(); }
  });
});
