import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions, KeyValidationResult, ProviderFetchOptions } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const FREEMODEL_BASE_URL = 'https://freemodel.in/v1';

function requireKey(key: string): void {
  if (!key.trim() || key === 'no-key') throw Object.assign(new Error('FreeModel API key is required'), { status: 401 });
}

function upstreamError(message: string): Error {
  return Object.assign(new Error(`FreeModel ${message}`), { status: 502 });
}

function checkIdentity(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}

/** Personal BYOK client. The account's monthly allowance is shared by every
 * route and requires Telegram verification. A funded wallet can incur charges
 * after that allowance: see docs/en/providers/freemodel.md. No model seeds or
 * public roster discovery: model delivery stays in the signed catalog.
 * Docs: https://freemodel.in/docs/coding-agents */
export class FreeModelProvider extends OpenAICompatProvider {
  constructor() { super({ platform: 'freemodel', name: 'FreeModel', baseUrl: FREEMODEL_BASE_URL }); }

  override get supportsKeyValidation(): boolean { return false; }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (!apiKey.trim() || apiKey === 'no-key') return { valid: false, error: 'FreeModel API key is required' };
    // /models is public; its 200 response proves nothing about this key.
    // Never repeatedly spend the user's monthly allowance on health probes.
    throw new Error('FreeModel has no verified credential-validation endpoint; validity is determined by real requests');
  }

  protected override fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number,
    options?: ProviderFetchOptions): Promise<Response> {
    if (url === `${FREEMODEL_BASE_URL}/chat/completions` && typeof init.body === 'string') {
      init = { ...init, body: JSON.stringify({ stream: false, ...JSON.parse(init.body) }) };
    }
    return super.fetchWithTimeout(url, { ...init, redirect: 'error' }, timeoutMs, options);
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    requireKey(apiKey);
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkIdentity(modelId, response.model);
    if (!response.choices?.some(c =>
      (typeof c.message?.content === 'string' && c.message.content.trim()) || c.message?.tool_calls?.length)) {
      throw upstreamError('returned an empty completion');
    }
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    requireKey(apiKey);
    let started = false;
    const preamble: ChatCompletionChunk[] = [];
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      if ('error' in chunk || !Array.isArray(chunk.choices)) throw upstreamError('returned a malformed stream event');
      // Usage-only terminal events may omit the model. Content frames may not.
      if (chunk.model || chunk.choices.length) checkIdentity(modelId, chunk.model);
      if (!started) {
        preamble.push(chunk);
        const usable = chunk.choices.some(c =>
          (typeof c.delta?.content === 'string' && c.delta.content.trim()) || c.delta?.tool_calls?.length);
        if (!usable) {
          if (preamble.length >= 64) throw upstreamError('returned an empty stream preamble');
          continue;
        }
        started = true;
        yield* preamble;
        preamble.length = 0;
      } else yield chunk;
    }
    // Do not commit empty role/finish frames: normal routing can still fail over.
    if (!started) throw upstreamError('returned an empty completion stream');
  }
}
