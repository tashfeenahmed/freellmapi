import type { KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

/** Free account access to auto/hrllm; numeric limits are not published.
 * https://llm.kiwi/docs and https://llm.kiwi/pricing (2026-11-05).
 * Models are managed by the signed catalog, not discovered from the paid roster.
 */
export class LlmKiwiProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'llmkiwi', name: 'LLM.kiwi', baseUrl: 'https://api.llm.kiwi/v1' });
  }

  override get supportsKeyValidation(): boolean {
    return false;
  }

  override async validateKey(_apiKey: string): Promise<KeyValidationResult> {
    // Live controls: /models returns 200 with no key AND with an invalid key.
    // No documented read-only authenticated probe; let real traffic establish
    // validity instead of spending the user's allowance on health checks.
    throw new Error('LLM.kiwi has no free credential-validation endpoint; key validity is unknown (no quota spent)');
  }
}
