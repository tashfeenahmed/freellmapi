import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const INFERBASE_BASE_URL = 'https://api.inferbase.ai/v1';

function checkModel(requested: string, returned: string): void {
  // Pin explicit catalog IDs, including :fp8/:turbo variants. Never silently
  // accept an auto-routed substitute as the requested model.
  if (returned !== requested) {
    throw Object.assign(new Error('Inferbase returned a different or missing model identity'), { status: 502 });
  }
}

/** Free managed chat shares monthly request and daily usage allowances.
 * Model rows remain exclusively in the signed, tier-gated catalog. */
export class InferbaseProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'inferbase', name: 'Inferbase', baseUrl: INFERBASE_BASE_URL,
      // /models is public. Read authenticated credits instead; a $0 balance
      // is valid on Free and must not disable the key.
      validateUrl: 'https://api.inferbase.ai/api/v1/inference/credits',
    });
  }

  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if ([401, 403].includes(response.status)) return super.validationResult(response);
    if (!response.ok) throw providerHttpError(response, 'Inferbase key validation is temporarily inconclusive');
    const body = await response.json().catch(() => null) as { balance_micros?: unknown } | null;
    if (typeof body?.balance_micros !== 'number' || !Number.isFinite(body.balance_micros)) {
      throw Object.assign(new Error('Inferbase returned an invalid credits response'), { status: 502 });
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
      // Inference failures may arrive as HTTP 200 SSE error events, including
      // after a valid role chunk. Never forward these as successful completions.
      if ('error' in chunk) {
        throw Object.assign(new Error('Inferbase returned an upstream stream error or malformed event'), { status: 502 });
      }
      // Inferbase interleaves routing and billing receipts with OpenAI chunks.
      // Validate their attribution but keep these provider-only frames out of
      // the client stream. The standard usage-only chunk is preserved below.
      if (['routing', 'usage'].includes(chunk.object)) {
        checkModel(modelId, chunk.model);
        continue;
      }
      if (!Array.isArray(chunk.choices)) {
        throw Object.assign(new Error('Inferbase returned a malformed stream event'), { status: 502 });
      }
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
