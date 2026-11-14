import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions, KeyValidationResult, ProviderFetchOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const SILVR_BASE_URL = 'https://api.silvrai.net/v1';
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw Object.assign(new Error('SilvR returned a different or missing model identity'), { status: 502 });
}

/** $3.50/day shared across the catalog, not a grant per model. Only tested
 * signed-catalog rows are routed; no model discovery, seeds or paid fallback.
 * https://silvrai.net/free and / (live checked November 14, 2026). */
export class SilvrProvider extends OpenAICompatProvider {
  constructor() { super({ platform: 'silvr', name: 'SilvR AI', baseUrl: SILVR_BASE_URL }); }
  override get supportsKeyValidation(): boolean { return false; }
  async validateKey(): Promise<KeyValidationResult> {
    throw new Error('SilvR key validity is established by the first completion, not its model list');
  }
  protected override fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number,
    options?: ProviderFetchOptions): Promise<Response> {
    return super.fetchWithTimeout(url, { ...init, redirect: 'error' }, timeoutMs, options);
  }
  override async chatCompletion(key: string, messages: ChatMessage[], model: string,
    options?: CompletionOptions, context?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const result = await super.chatCompletion(key, messages, model, options, context);
    checkModel(model, result.model);
    if (!result.choices?.some(c => typeof c.message?.content === 'string' && c.message.content.trim() || c.message?.tool_calls?.length)) {
      throw Object.assign(new Error('SilvR returned an empty completion'), { status: 502 });
    }
    return result;
  }
  override async *streamChatCompletion(key: string, messages: ChatMessage[], model: string,
    options?: CompletionOptions, context?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    let identified = false;
    for await (const chunk of super.streamChatCompletion(key, messages, model, options, context)) {
      if ('error' in chunk || !Array.isArray(chunk.choices)) {
        throw Object.assign(new Error('SilvR returned an upstream stream error or malformed event'), { status: 502 });
      }
      if (chunk.model || chunk.choices.length || !identified) { checkModel(model, chunk.model); identified = true; }
      yield chunk;
    }
    if (!identified) checkModel(model, undefined);
  }
}
