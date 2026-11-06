import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const NABH_BASE_URL = 'https://api.nabh.cloud/v1';

function checkModel(requested: string, returned: string): void {
  if (requested !== returned) {
    throw Object.assign(new Error('nabh.cloud returned a different or missing model identity'), { status: 502 });
  }
}

/** OpenAI-compatible chat. Only catalog-approved free-plan routes are seeded
 * remotely; /models also lists paid-plan models and is NOT a free-model list.
 * The monthly credits and rate limits are account-wide. X-Balance-INR is an
 * INR wallet balance (including paid top-ups), not a USD or token allowance.
 * Docs: https://nabh.cloud/docs/quickstart/ */
export class NabhProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'nabh', name: 'nabh.cloud', baseUrl: NABH_BASE_URL });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // Verified 2026-10-31: missing/bogus keys return 401; a valid key returns
    // the model list. This read-only check does not spend inference credits.
    const response = await this.fetchModelCatalog(apiKey, quotaContext);
    if ([401, 403].includes(response.status)) return this.validationResult(response);
    if (!response.ok) throw providerHttpError(response, 'nabh.cloud key validation is temporarily inconclusive');
    const body = await response.json().catch(() => null) as { data?: unknown } | null;
    if (!Array.isArray(body?.data)) {
      throw Object.assign(new Error('nabh.cloud returned an invalid model catalog'), { status: 502 });
    }
    return true;
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    let identified = false;
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      if (chunk.model || chunk.choices?.length) {
        checkModel(modelId, chunk.model);
        identified = true;
      }
      if (!identified) checkModel(modelId, chunk.model);
      yield chunk;
    }
    if (!identified) checkModel(modelId, '');
  }
}
