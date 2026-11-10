import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider } from './base.js';

export const FISH_AUDIO_BASE_URL = 'https://api.fish.audio';
export const FISH_AUDIO_FREE_ENDS_AT = Date.parse('2026-12-01T00:00:00Z');

/** Fish Audio contributes a TTS credential only; synthesis runs through
 * services/media.ts. The free S2.1 route is promotional through 2026-11-30. */
export class FishAudioProvider extends BaseProvider {
  readonly platform = 'fishaudio' as const;
  readonly name = 'Fish Audio';

  override get supportsKeyValidation(): boolean { return false; }
  override get supportsKeyPolling(): boolean { return false; }

  async validateKey(): Promise<never> {
    throw new Error('Fish Audio keys are checked by the first real synthesis request; no probe is sent');
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('Fish Audio supports text-to-speech, not chat completions'), { status: 422 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('Fish Audio supports text-to-speech, not chat completions'), { status: 422 });
  }
}
