import type { KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

/** OpenAI-compatible MNN gateway. The public roster includes paid routes and
 * does not distinguish free-plan eligibility. Do not seed models here; only
 * publish routes after the Free subscription's access and credit behavior is
 * verified against the signed hosted catalog. */
export class MnnProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'mnn', name: 'MNN', baseUrl: 'https://api.mnnai.ru/v1' });
  }

  override get supportsKeyValidation(): boolean { return false; }

  override async validateKey(_apiKey: string): Promise<KeyValidationResult> {
    // Live controls: /models returns a public roster for invalid credentials.
    // No authenticated free metadata probe is documented.
    throw new Error('MNN has no verified credential-only endpoint; key validity is unknown (no usage spent)');
  }
}
