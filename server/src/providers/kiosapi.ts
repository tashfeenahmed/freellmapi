import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions, KeyValidationResult, ProviderFetchOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const KIOSAPI_BASE_URL = 'https://api.kiosapi.id/v1';

// Only these named free routes were verified. The public roster also lists
// paid models. Aliases are exact, observed upstream identities, not wildcards.
const FREE_ROUTES: Readonly<Record<string, string>> = {
  'meta/llama-3.1-8b': '@cf/meta/llama-3.1-8b-instruct-fp8',
  'qwen/qwen3-30b': '@cf/qwen/qwen3-30b-a3b-fp8',
  'zai/glm-4.7-flash': '@cf/zai-org/glm-4.7-flash',
  'google/gemma-4-26b': '@cf/google/gemma-4-26b-a4b-it',
  'aisingapore/sea-lion-27b': '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
};
const upstreamError = (message: string) => Object.assign(new Error(`KiosAPI ${message}`), { status: 502 });
function requireFree(model: string): void {
  if (!Object.hasOwn(FREE_ROUTES, model)) {
    throw Object.assign(new Error('KiosAPI requires a verified free model route'), { status: 400 });
  }
}
function checkIdentity(requested: string, returned: unknown): void {
  if (returned !== requested && returned !== FREE_ROUTES[requested]) {
    throw upstreamError('returned a different or missing model identity');
  }
}

/** https://kiosapi.id/docs — 50 shared free requests/day without a top-up.
 * Catalog-only: no bundled rows or automatic discovery that bypasses tiers. */
export class KiosAPIProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'kiosapi', name: 'KiosAPI', baseUrl: KIOSAPI_BASE_URL, timeoutMs: 90_000 });
  }

  override get supportsKeyValidation(): boolean { return false; }
  override async validateKey(_apiKey: string): Promise<KeyValidationResult> {
    // /models is public. Do not consume one of the 50 requests for a health
    // probe; the first actual served request establishes credential health.
    throw new Error('KiosAPI has no documented free credential-validation endpoint; key validity is unknown (no quota spent)');
  }

  protected override fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number,
    options?: ProviderFetchOptions): Promise<Response> {
    return super.fetchWithTimeout(url, { ...init, redirect: 'error' }, timeoutMs, options);
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    requireFree(modelId);
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkIdentity(modelId, response.model);
    if (!response.choices?.some(c =>
      (typeof c.message?.content === 'string' && c.message.content.trim()) || c.message?.tool_calls?.length)) {
      throw upstreamError('returned an empty completion');
    }
    return { ...response, model: modelId };
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    requireFree(modelId);
    let started = false;
    let preambleBytes = 0;
    const preamble: ChatCompletionChunk[] = [];
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      if ('error' in chunk || !Array.isArray(chunk.choices)) throw upstreamError('returned a malformed stream event');
      if (chunk.model || chunk.choices.length) checkIdentity(modelId, chunk.model);
      const normalized = { ...chunk, model: modelId };
      if (!started) {
        preamble.push(normalized);
        preambleBytes += Buffer.byteLength(JSON.stringify(normalized));
        const usable = chunk.choices.some(c =>
          (typeof c.delta?.content === 'string' && c.delta.content.trim()) || c.delta?.tool_calls?.length);
        if (!usable) {
          // Qwen emits hundreds of reasoning-only frames before its answer.
          // Hold them for failover, with both byte and frame bounds.
          if (preamble.length >= 1024 || preambleBytes > 256 * 1024) throw upstreamError('returned an excessive empty stream preamble');
          continue;
        }
        started = true;
        yield* preamble;
        preamble.length = 0;
      } else yield normalized;
    }
    if (!started) throw upstreamError('returned an empty completion stream');
  }
}
