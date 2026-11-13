import { OpenAICompatProvider } from './openai-compat.js';

export const MIXLAYER_BASE_URL = 'https://models.mixlayer.ai/v1';
export const MIXLAYER_FREE_MODEL = 'qwen/qwen3.5-4b-free';

/**
 * Mixlayer exposes an OpenAI-compatible inference API.
 *
 * Free-model availability and key-validation behavior still need to be
 * tested before this provider is submitted or published.
 */
export class MixlayerProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'mixlayer',
      name: 'Mixlayer',
      baseUrl: MIXLAYER_BASE_URL,
    });
  }
}
