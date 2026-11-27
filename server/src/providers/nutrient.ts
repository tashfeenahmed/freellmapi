import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from '../lib/content.js';
import { providerHttpError, type CompletionOptions, type ProviderFetchOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

const freeChat = new Set(['nutrient-s', 'nutrient-m']);
const origin = 'https://api.nutrient.io/ai/v1';
const invalid = (message: string, status = 502) => Object.assign(new Error(message), { status });
function checkRoute(id: string) {
  if (!freeChat.has(id)) throw invalid('Unsupported free Nutrient route', 400);
}
function checkIdentity(model: unknown, requested: string) {
  if (model !== requested) throw invalid('Nutrient returned an unexpected model');
}

export class NutrientProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'nutrient', name: 'Nutrient', baseUrl: origin });
  }

  protected override async fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number, options?: ProviderFetchOptions) {
    const res = await super.fetchWithTimeout(url, { ...init, redirect: 'error' }, timeoutMs, options);
    if (!res.ok && init.method === 'POST') {
      await res.body?.cancel();
      throw providerHttpError(res, 'Nutrient declined the request (' + res.status + ')');
    }
    return res;
  }

  override async chatCompletion(key: string, messages: ChatMessage[], model: string, options?: CompletionOptions, quota?: QuotaObservationContext) {
    checkRoute(model);
    const result = await super.chatCompletion(key, messages, model, options, quota);
    checkIdentity(result.model, model);
    if (!result.choices?.some(c => contentToString(c.message?.content).trim() || c.message?.tool_calls?.length)) throw invalid('Empty Nutrient completion');
    return result;
  }

  override async *streamChatCompletion(key: string, messages: ChatMessage[], model: string, options?: CompletionOptions, quota?: QuotaObservationContext) {
    checkRoute(model);
    let identified = false, finished = false;
    for await (const chunk of super.streamChatCompletion(key, messages, model, options, quota)) {
      if ('error' in chunk || !Array.isArray(chunk.choices)) throw invalid('Nutrient returned an error in its stream');
      if (!identified || chunk.model || chunk.choices.length) { checkIdentity(chunk.model, model); identified = true; }
      if (chunk.choices.some(c => c.finish_reason != null)) finished = true;
      yield chunk;
    }
    if (!identified || !finished) throw invalid('Incomplete Nutrient stream');
  }
}
