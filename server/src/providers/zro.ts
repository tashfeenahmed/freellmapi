import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult, type ProviderFetchOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const ZRO_BASE_URL = 'https://zro.moonmath.ai/v1';

function checkModel(requested: string, returned: unknown): void {
  // Zro documents only this namespace alias. Never accept a retired model
  // silently returning a different model, or strip arbitrary vendor prefixes.
  const bare = (id: string) => id.startsWith('zro/') ? id.slice(4) : id;
  if (typeof returned !== 'string' || !returned || bare(requested) !== bare(returned)) {
    throw Object.assign(new Error('Zro returned a different or missing model identity'), { status: 502 });
  }
}

/** Zro by MoonMath.ai: Free DeepSeek usage resets daily, not monthly. Other
 * models and usage packs can be paid. Only the signed hosted catalog supplies
 * approved free routes; no model seeds or inferred numeric allowance.
 * Docs: https://zro.moonmath.ai/docs/api and /pricing (checked 2026-11-12). */
export class ZroProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'zro', name: 'Zro (MoonMath.ai)', baseUrl: ZRO_BASE_URL });
  }

  protected override fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number,
    options?: ProviderFetchOptions): Promise<Response> {
    return super.fetchWithTimeout(url, { ...init, redirect: 'error' }, timeoutMs, options);
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    if (!apiKey.trim() || apiKey === 'no-key') return { valid: false, error: 'Zro API key is required' };
    // Live-verified: missing/bogus credentials get 401, while a valid key gets
    // its permitted models. This read-only probe never consumes inference.
    const response = await this.fetchModelCatalog(apiKey, quotaContext);
    if ([401, 403].includes(response.status)) return { valid: false, error: 'Zro API key is invalid or not permitted' };
    if (!response.ok) throw providerHttpError(response, 'Zro key validation is temporarily inconclusive');
    const body = await response.json().catch(() => null) as { data?: { id?: unknown }[]; error?: unknown } | null;
    if (body?.error || !Array.isArray(body?.data) || !body.data.every(row => row && typeof row.id === 'string')) {
      throw Object.assign(new Error('Zro returned an invalid model catalog'), { status: 502 });
    }
    return true;
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    if (!response.choices?.some(choice =>
      (typeof choice.message?.content === 'string' && choice.message.content.trim()) || choice.message?.tool_calls?.length)) {
      throw Object.assign(new Error('Zro returned an empty completion'), { status: 502 });
    }
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    let identified = false;
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      if ('error' in chunk || !Array.isArray(chunk.choices)) {
        throw Object.assign(new Error('Zro returned an upstream stream error or malformed event'), { status: 502 });
      }
      // Usage-only events can omit model; content/tool/reasoning events cannot.
      if (chunk.model || chunk.choices?.length || !identified) {
        checkModel(modelId, chunk.model);
        identified = true;
      }
      yield chunk;
    }
    if (!identified) checkModel(modelId, undefined);
  }
}
