import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, type KeyValidationResult } from './base.js';

/** Roboflow CLIP is embeddings-only. Rows arrive via the signed catalog. */
export class RoboflowProvider extends BaseProvider {
  readonly platform = 'roboflow' as const;
  readonly name = 'Roboflow';
  readonly supportsChat = false;
  override get supportsKeyValidation(): boolean { return false; }

  async validateKey(): Promise<KeyValidationResult> {
    throw new Error('Roboflow key validity is established by the first authenticated embedding request');
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('Roboflow supports embeddings, not chat'), { status: 400 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('Roboflow supports embeddings, not chat'), { status: 400 });
  }
}
