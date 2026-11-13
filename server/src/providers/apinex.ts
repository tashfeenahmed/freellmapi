import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const APINEX_BASE_URL = 'https://api.apinex.bond/v1';

function checkModel(requested: string, returned: string): void {
  if (requested !== returned) {
    throw Object.assign(new Error('APINex returned a different or missing model identity'), { status: 502 });
  }
}

/** Free-category chat shares a weighted daily allowance with decisions.
 * Preserve free/ exactly; never retry a paid alias. Eligibility and model
 * rows belong exclusively in the signed, tier-selected catalog. */
export class ApinexProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'apinex', name: 'APINex', baseUrl: APINEX_BASE_URL, validateUrl: `${APINEX_BASE_URL}/balance` });
  }

  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if ([401, 403].includes(response.status)) return super.validationResult(response);
    if (!response.ok) throw providerHttpError(response, 'APINex key validation is temporarily inconclusive');
    const body = await response.json().catch(() => null) as { object?: unknown; balance_usd?: unknown; error?: unknown } | null;
    if (body?.object !== 'balance' || body.error || typeof body.balance_usd !== 'number' || !Number.isFinite(body.balance_usd)) {
      throw Object.assign(new Error('APINex returned an invalid balance response'), { status: 502 });
    }
    // A zero-dollar wallet is valid: free-category calls use the daily pool.
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
      if ('error' in chunk || !Array.isArray(chunk.choices)) {
        throw Object.assign(new Error('APINex returned an upstream stream error or malformed event'), { status: 502 });
      }
      // Usage-only terminal frames may omit model, but every content-bearing
      // frame must carry the exact route. Do not accept an empty stream.
      if (chunk.model || chunk.choices.length) {
        checkModel(modelId, chunk.model);
        identified = true;
      }
      if (!identified) checkModel(modelId, chunk.model);
      yield chunk;
    }
    if (!identified) checkModel(modelId, '');
  }
}
