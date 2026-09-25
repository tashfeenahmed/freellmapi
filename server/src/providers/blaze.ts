import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

function checkModel(requested: string, returned: string): void {
  if (!returned || returned !== requested) {
    throw Object.assign(new Error('BlazeAPI returned a different or missing model identity'), { status: 502 });
  }
}

export class BlazeProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'BlazeAPI key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    // Despite its name, /paid/v1 is also the documented Free-plan endpoint.
    // Named catalog routes only: no fallback to a paid or automatic route.
    super({ platform: 'blaze', name: 'BlazeAPI', baseUrl: 'https://api.blazeapi.org/paid/v1',
      validateUrl: 'https://api.blazeapi.org/paid/v1/usage' });
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
