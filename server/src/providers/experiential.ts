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
    // 4.6 reasoning routes additionally constrain top_p to [0.99, 1]; the
    // newer routes reject it entirely. Omit both on the fixed-temperature
    // routes. Other Claude routes accept either knob, but reject both together
    // (live-reproduced on Haiku 4.5); prefer the requested temperature there.
    const fixed = FIXED_TEMPERATURE_MODELS.has(modelId);
    const competingClaudeSampling = modelId.startsWith('claude-') &&
      sampling.temperature !== undefined && sampling.topP !== undefined;
    return {
      temperature: fixed ? undefined : sampling.temperature,
      topP: fixed || competingClaudeSampling ? undefined : sampling.topP,
    };
  }
}
