import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const BLOCKRUN_BASE_URL = 'https://api.blockrun.ai/v1';

function checkModel(requested: string, returned: unknown): void {
  // Free capacity can silently substitute a different model with HTTP 200.
  // Reject before returning/yielding so the router can try another route.
  if (returned !== requested) {
    throw Object.assign(new Error('BlockRun returned a different or missing model identity'), { status: 502 });
  }
}

/** API-key gateway, NOT the separate wallet/x402 endpoint. Only tested $0
 * routes enter the signed catalog; the public roster also includes paid IDs. */
export class BlockRunProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'blockrun', name: 'BlockRun', baseUrl: BLOCKRUN_BASE_URL,
      validateUrl: `${BLOCKRUN_BASE_URL}/account` });
  }

  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'BlockRun key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      checkModel(modelId, chunk.model);
      yield chunk;
    }
  }
}
