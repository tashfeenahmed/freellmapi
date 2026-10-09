import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const SIMPLELLM_BASE_URL = 'https://api.simplellm.eu/v1';
const RETURNED_ALIASES: Readonly<Record<string, string>> = {
  'free-gemma-4-E4B': 'gemma-4-E4B',
  'free-Llama-3.1-8B-Instruct': 'Llama-3.1-8B',
};

function checkModel(requested: string, returned: string): void {
  if (returned !== requested && (!RETURNED_ALIASES[requested] || returned !== RETURNED_ALIASES[requested])) {
    throw Object.assign(new Error('SimpleLLM returned a different or missing model identity'), { status: 502 });
  }
}

function wireOptions(options?: CompletionOptions): CompletionOptions | undefined {
  // SimpleLLM accepts stop arrays, not a scalar stop string.
  return typeof options?.stop === 'string' ? { ...options, stop: [options.stop] } : options;
}

export class SimpleLLMProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'simplellm', name: 'SimpleLLM', baseUrl: SIMPLELLM_BASE_URL,
      validateUrl: `${SIMPLELLM_BASE_URL}/rate-limit` });
  }

  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if ([401, 403].includes(response.status)) return super.validationResult(response);
    if (!response.ok) throw providerHttpError(response, 'SimpleLLM key validation is temporarily inconclusive');
    const body = await response.json().catch(() => null) as { limit_rpm?: unknown } | null;
    if (typeof body?.limit_rpm !== 'number' || !Number.isFinite(body.limit_rpm)) {
      throw Object.assign(new Error('SimpleLLM returned an invalid rate-limit response'), { status: 502 });
    }
    return true;
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, wireOptions(options), quotaContext);
    checkModel(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    let identified = false;
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, wireOptions(options), quotaContext)) {
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
