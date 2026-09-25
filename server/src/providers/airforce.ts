import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

function checkModel(requested: string, returned: string): void {
  if (!returned || returned !== requested) {
    throw Object.assign(new Error('Api.Airforce returned a different or missing model identity'), { status: 502 });
  }
}

export class AirforceProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'Api.Airforce key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    // One request per minute per account: a 429 carries Retry-After and is
    // surfaced as-is so the router backs off instead of retrying into it.
    super({ platform: 'airforce', name: 'Api.Airforce', baseUrl: 'https://api.airforce/v1' });
  }

  override async chatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      checkModel(modelId, chunk.model);
      yield chunk;
    }
  }
}
