import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type KeyValidationResult } from './base.js';

export const VAROSITY_BASE_URL = 'https://varosity.ai/api';

/** Native media API, not an OpenAI-compatible chat endpoint. Model rows are
 * delivered by the hosted catalog; adding a key never seeds local models. */
export class VarosityProvider extends BaseProvider {
  readonly platform = 'varosity' as const;
  readonly name = 'Varosity';
  readonly supportsChat = false;

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (!apiKey.trim()) return { valid: false, error: 'Varosity API key is required' };
    // The roster is public. This authenticated, non-generating endpoint checks
    // the key without spending the shared daily allowance.
    const response = await this.fetchWithTimeout(`${VAROSITY_BASE_URL}/v1/credits/balance`, {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.status === 401) return { valid: false, error: 'Invalid Varosity API key' };
    // 403 can mean insufficient scope, not an invalid credential.
    if (!response.ok) throw providerHttpError(response, 'Varosity key validation is inconclusive');
    const body = await response.json() as { ok?: unknown; balance_cents?: unknown } | null;
    if (body?.ok !== true || typeof body.balance_cents !== 'number' || !Number.isFinite(body.balance_cents)) {
      throw new Error('Varosity returned an invalid balance response; key validity is unknown');
    }
    return true;
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('Varosity supports image, speech/music and video endpoints, not chat'), { status: 400 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('Varosity supports image, speech/music and video endpoints, not chat'), { status: 400 });
  }
}
