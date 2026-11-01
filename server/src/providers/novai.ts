import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, type KeyValidationResult } from './base.js';

export const NOVAI_BASE_URL = 'https://aiapi-pro.com/v1';

/** Only the live-tested daily-free video route is integrated. Model rows are
 * delivered by the signed catalog, never seeded when a key is registered. */
export class NovaiProvider extends BaseProvider {
  readonly platform = 'novai' as const;
  readonly name = 'NovAI';
  override get supportsKeyValidation(): boolean { return false; }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (!apiKey.trim()) return { valid: false, error: 'NovAI API key is required' };
    // /models is public and cannot authenticate a credential. Do not spend a
    // video generation (or pretend that a public roster validates the key).
    throw new Error('NovAI has no verified credential-validation endpoint; key validity is unknown');
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('NovAI currently supports video generation, not chat completions'), { status: 400 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('NovAI currently supports video generation, not chat completions'), { status: 400 });
  }
}
