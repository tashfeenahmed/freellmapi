import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from '../lib/content.js';
import { providerHttpError, type CompletionOptions, type ProviderFetchOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const MELDPORT_FREE_CHAT = 'gpt-6-luna:free';
const origin = 'https://api.meldport.com/v1';
const invalid = (message: string, status = 502) => Object.assign(new Error(message), { status });
function checkRoute(id: string) {
  if (id !== MELDPORT_FREE_CHAT) throw invalid('Unsupported free Meldport route', 400);
}
function checkIdentity(model: unknown) {
  if (model !== 'gpt-6-luna' && model !== MELDPORT_FREE_CHAT) throw invalid('Meldport returned an unexpected model');
}

export class MeldportProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'meldport', name: 'Meldport', baseUrl: origin, extraHeaders: { 'X-Meldport-Funding': 'promo' } });
  }

  protected override async fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number, options?: ProviderFetchOptions) {
    const res = await super.fetchWithTimeout(url, { ...init, redirect: 'error' }, timeoutMs, options);
    if (!res.ok && init.method === 'POST') {
      await res.body?.cancel();
      throw providerHttpError(res, 'Meldport declined the allowance-funded request (' + res.status + ')');
    }
    if (res.ok && init.method === 'POST' && res.headers.get('x-meldport-funding') !== 'promo') {
      await res.body?.cancel();
      throw invalid('Meldport did not confirm allowance funding');
    }
    return res;
  }

  override async chatCompletion(key: string, messages: ChatMessage[], model: string, options?: CompletionOptions, quota?: QuotaObservationContext) {
    checkRoute(model);
    const result = await super.chatCompletion(key, messages, model, options, quota);
    checkIdentity(result.model);
    if (!result.choices?.some(c => contentToString(c.message?.content).trim() || c.message?.tool_calls?.length)) throw invalid('Empty Meldport completion');
    return result;
  }

  override async *streamChatCompletion(key: string, messages: ChatMessage[], model: string, options?: CompletionOptions, quota?: QuotaObservationContext) {
    checkRoute(model);
    let identified = false, finished = false;
    for await (const chunk of super.streamChatCompletion(key, messages, model, options, quota)) {
      if ('error' in chunk || !Array.isArray(chunk.choices)) throw invalid('Meldport returned an error in its stream');
      if (!identified || chunk.model || chunk.choices.length) { checkIdentity(chunk.model); identified = true; }
      if (chunk.choices.some(c => c.finish_reason != null)) finished = true;
      yield chunk;
    }
    if (!identified || !finished) throw invalid('Incomplete Meldport stream');
  }
}
