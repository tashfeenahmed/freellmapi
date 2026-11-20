import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, type KeyValidationResult } from './base.js';

/** User-entered keyId:keySecret; neither half is a bearer token. */
export function speechFlowCredentials(value: string): { keyId: string; keySecret: string } | null {
  const pair = /^([A-Za-z0-9_.~-]{1,256}):([A-Za-z0-9_.~-]{1,256})$/.exec(value);
  return pair ? { keyId: pair[1], keySecret: pair[2] } : null;
}

export class SpeechFlowProvider extends BaseProvider {
  readonly platform = 'speechflow' as const;
  readonly name = 'SpeechFlow';
  readonly supportsChat = false;
  override get supportsKeyValidation(): boolean { return false; }

  async validateKey(): Promise<KeyValidationResult> {
    throw new Error('SpeechFlow has no documented non-generating credential probe; validity is established by the first speech request');
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('SpeechFlow supports file transcription, not chat'), { status: 400 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('SpeechFlow supports file transcription, not chat'), { status: 400 });
  }
}
