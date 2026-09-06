import type { CompletionOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

// Verified against /api/models on 2026-09-06; Opus 5 also returned a live 400
// for temperature=0.7. These reasoning routes fix temperature at 1. Omission
// lets the gateway apply its supported default, rather than forwarding the
// dashboard's normal 0.7 into a guaranteed rejection. No catalog rows seeded.
const FIXED_TEMPERATURE_MODELS = new Set([
  'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
  'claude-opus-4.6', 'claude-opus-4.7', 'claude-opus-4.8', 'claude-sonnet-4.6',
]);
const NO_TOP_P_MODELS = new Set([
  'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4.7', 'claude-opus-4.8',
]);

export class ExperientialProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'experiential',
      name: 'Experiential Labs',
      baseUrl: 'https://api.experientiallabs.ai/v1',
    });
  }

  protected override samplingForModel(modelId: string, options?: CompletionOptions) {
    const sampling = super.samplingForModel(modelId, options);
    return {
      temperature: FIXED_TEMPERATURE_MODELS.has(modelId) ? undefined : sampling.temperature,
      topP: NO_TOP_P_MODELS.has(modelId) ? undefined : sampling.topP,
    };
  }
}
