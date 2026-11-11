import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions, KeyValidationResult, ProviderFetchOptions } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const FREEINFERENCE_BASE_URL = 'https://freeinference.org/v1';
const TESTED_CHAT_MODELS = new Set(['qwen3.6-35b', 'deepseek-v4-flash']);

function checkRequest(key: string, model: string): void {
  if (!key.trim() || key === 'no-key') throw Object.assign(new Error('FreeInference API key is required'), { status: 401 });
  if (!TESTED_CHAT_MODELS.has(model)) throw Object.assign(new Error('FreeInference chat supports only tested free chat routes'), { status: 400 });
}

function checkIdentity(requested: string, returned: unknown): void {
  if (returned !== requested) throw Object.assign(new Error('FreeInference returned a different or missing model identity'), { status: 502 });
}

/** Research service: prompts/responses are logged. Account access varies and
 * chat/embeddings share a daily quota, reset at 00:00 UTC. No model seeds:
 * only the signed catalog may deliver rows through the existing tier gate.
 * Docs: https://doc.freeinference.org/models and /agents */
export class FreeInferenceProvider extends OpenAICompatProvider {
  constructor() { super({ platform: 'freeinference', name: 'FreeInference', baseUrl: FREEINFERENCE_BASE_URL }); }

  override get supportsKeyValidation(): boolean { return false; }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (!apiKey.trim()) return { valid: false, error: 'FreeInference API key is required' };
    // Live-verified 2026-11-04: /models returns 200 for missing AND bogus keys.
    // Never label these keys healthy or repeatedly spend inference to probe.
    throw new Error('FreeInference has no verified credential-validation endpoint; validity is determined by real requests');
  }

  protected override fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number, fetchOpts?: ProviderFetchOptions): Promise<Response> {
    // Match the tested non-streaming wire shape without changing other providers.
    if (url === `${FREEINFERENCE_BASE_URL}/chat/completions` && typeof init.body === 'string') {
      const body = JSON.parse(init.body);
      init = { ...init, body: JSON.stringify({ stream: false, ...body }) };
    }
    return super.fetchWithTimeout(url, { ...init, redirect: 'error' }, timeoutMs, fetchOpts);
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    checkRequest(apiKey, modelId);
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkIdentity(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    checkRequest(apiKey, modelId);
    let identified = false;
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      if (chunk.model || chunk.choices?.length || !identified) {
        checkIdentity(modelId, chunk.model);
        identified = true;
      }
      yield chunk;
    }
    if (!identified) checkIdentity(modelId, undefined);
  }
}
