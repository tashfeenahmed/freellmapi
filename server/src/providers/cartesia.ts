import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type KeyValidationResult } from './base.js';

export const CARTESIA_BASE_URL = 'https://api.cartesia.ai';
export const CARTESIA_VERSION = '2026-08-14';

/** Cartesia is routed only through the audio and transcription media paths. */
export class CartesiaProvider extends BaseProvider {
  readonly platform = 'cartesia' as const;
  readonly name = 'Cartesia';

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${CARTESIA_BASE_URL}/models`, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Cartesia-Version': CARTESIA_VERSION },
    }, 10_000, { timeoutBounds: 'request' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (!res.ok) throw providerHttpError(res, 'Cartesia key validation is inconclusive');
    const body = await res.json().catch(() => null) as { data?: unknown } | null;
    if (!Array.isArray(body?.data)) throw Object.assign(new Error('Cartesia returned an invalid model list'), { status: 502 });
    return true;
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('Cartesia supports speech and transcription, not chat completions'), { status: 422 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('Cartesia supports speech and transcription, not chat completions'), { status: 422 });
  }
}
