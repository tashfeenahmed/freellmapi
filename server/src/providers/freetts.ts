import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, type KeyValidationResult } from './base.js';

/** Local, personal BYOK speech. The public voice list does not validate a key;
 * adding a credential must never generate audio or seed tier-gated models. */
export class FreeTtsProvider extends BaseProvider {
  readonly platform = 'freetts' as const;
  readonly name = 'FreeTTS';
  readonly supportsChat = false;
  override get supportsKeyValidation(): boolean { return false; }

  async validateKey(): Promise<KeyValidationResult> {
    throw new Error('FreeTTS key validity is established by the first speech request, not its public voice list');
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('FreeTTS supports text-to-speech, not chat'), { status: 400 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('FreeTTS supports text-to-speech, not chat'), { status: 400 });
  }
}
