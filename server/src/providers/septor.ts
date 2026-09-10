import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

function checkModel(requested: string, returned: string): void {
  // Explicit auto routing may choose a model; a named model may not silently
  // substitute another one. Live Sep 10 probes returned MiniMax M2.5 for
  // eleven unrelated free IDs. Keep those routes out of the catalog and fail
  // over if a previously working named route starts doing the same.
  if (requested !== 'auto' && returned !== requested) {
    throw Object.assign(new Error('Septor Labs returned a different or missing model identity'), { status: 502 });
  }
}

export class SeptorProvider extends OpenAICompatProvider {
  constructor() {
    // /models rejects missing and invalid credentials (401), unlike Router9.
    super({ platform: 'septor', name: 'Septor Labs', baseUrl: 'https://api.septorlabs.com/v1' });
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
      // Verify before yielding even a role/content/tool preamble. Never label
      // an upstream substitution as the requested model in the client stream.
      checkModel(modelId, chunk.model);
      yield chunk;
    }
  }
}
