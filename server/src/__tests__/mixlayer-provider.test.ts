import { describe, expect, it } from 'vitest';
import { getProvider, hasProvider } from '../providers/index.js';
import {
  MIXLAYER_BASE_URL,
  MIXLAYER_FREE_MODEL,
  MixlayerProvider,
} from '../providers/mixlayer.js';

describe('Mixlayer provider registration', () => {
  it('registers Mixlayer under its platform name', () => {
    expect(hasProvider('mixlayer')).toBe(true);

    const provider = getProvider('mixlayer');
    expect(provider).toBeInstanceOf(MixlayerProvider);
    expect(provider?.platform).toBe('mixlayer');
    expect(provider?.name).toBe('Mixlayer');
  });

  it('uses the configured Mixlayer model-list endpoint', () => {
    const provider = new MixlayerProvider();

    expect(provider.modelsUrl).toBe(`${MIXLAYER_BASE_URL}/models`);
    expect(MIXLAYER_FREE_MODEL).toBe('qwen/qwen3.5-4b-free');
  });
});
