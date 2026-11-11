import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, type KeyValidationResult } from './base.js';

/** Native speech only. Models are delivered by the signed catalog, not seeded
 * when a key is added. The $50 monthly grant is shared across all Rime models. */
export class RimeProvider extends BaseProvider {
  readonly platform = 'rime' as const;
  readonly name = 'Rime';
  readonly supportsChat = false;
  override get supportsKeyValidation(): boolean { return false; }

  async validateKey(): Promise<KeyValidationResult> {
    // Public voice lists do not authenticate. Never claim a key is healthy or
    // synthesize billable audio just to validate it; real requests establish it.
    throw new Error('Rime has no documented non-generating credential probe; validity is established by the first speech request');
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('Rime supports TTS and transcription, not chat'), { status: 400 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('Rime supports TTS and transcription, not chat'), { status: 400 });
  }
}
