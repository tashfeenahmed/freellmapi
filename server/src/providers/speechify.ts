import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type KeyValidationResult } from './base.js';

export const SPEECHIFY_BASE_URL = 'https://api.speechify.ai/v1';
export const SPEECHIFY_VERSION = '2026-09-08';

/** Speechify is TTS-only. Synthesis is dispatched by services/media.ts;
 * registration here provides credential management, not a fake chat API. */
export class SpeechifyProvider extends BaseProvider {
  readonly platform = 'speechify' as const;
  readonly name = 'Speechify';

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const response = await this.fetchWithTimeout(`${SPEECHIFY_BASE_URL}/workspaces/current/entitlements`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Speechify-Version': SPEECHIFY_VERSION },
    });
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'Speechify key validation is temporarily inconclusive');
    }
    return this.validationResult(response);
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('Speechify supports /v1/audio/speech, not chat completions'), { status: 400 });
  }

  // An unsupported operation must reject before yielding any stream data.
  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('Speechify supports /v1/audio/speech, not chat completions'), { status: 400 });
  }
}
