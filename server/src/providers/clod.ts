import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

function checkModel(requested: string, returned: string): void {
  // CLōD accepts friendly names including spaces, then reports the upstream
  // namespaced ID. Compare their significant characters, not a hardcoded
  // roster. Never accept the observed Llama/Trinity -> Gemma substitution.
  const normalize = (id: string) => id.split('/').at(-1)!.toLowerCase().replace(/[\s._-]/g, '');
  if (typeof returned !== 'string' || !returned || normalize(requested) !== normalize(returned)) {
    throw Object.assign(new Error('CLōD returned a different or missing model identity'), { status: 502 });
  }
}

export class ClodProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'CLōD key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    super({ platform: 'clod', name: 'CLōD', baseUrl: 'https://api.clod.io/v1' });
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
