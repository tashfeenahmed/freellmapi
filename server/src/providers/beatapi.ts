import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type KeyValidationResult } from './base.js';

export const BEATAPI_BASE_URL = 'https://api.beatapi.io/v1';

/** Decision-only integration. Model availability and promotional terms live
 * in the signed catalog, not bundled seeds or the chat router. */
export class BeatApiProvider extends BaseProvider {
  readonly platform = 'beatapi' as const;
  readonly name = 'BeatAPI';

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${BEATAPI_BASE_URL}/models`, {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}` },
    }, 10_000, { timeoutBounds: 'request' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (!res.ok) throw providerHttpError(res, 'BeatAPI key validation is inconclusive');
    const body = await res.json().catch(() => null) as { data?: unknown; error?: unknown } | null;
    if (!Array.isArray(body?.data) || body?.error) {
      throw Object.assign(new Error('BeatAPI returned an invalid model list'), { status: 502 });
    }
    return true;
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('BeatAPI integration supports /v1/decisions, not chat completions'), { status: 422 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('BeatAPI integration supports /v1/decisions, not chat completions'), { status: 422 });
  }
}
