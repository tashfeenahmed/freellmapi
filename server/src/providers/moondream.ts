import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, Platform } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { resolveMaxTokens } from '../lib/sampling-params.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

const BASE_URL = 'https://api.moondream.ai/v1';
const unsupported = (message: string) => Object.assign(new Error(`Moondream ${message}`), { status: 422 });
const upstreamError = (message: string) => Object.assign(new Error(`Moondream ${message}`), { status: 502 });

function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}

/** Hosted BYOK API, not self-hosted weights. Model rows belong exclusively in
 * the signed catalog to preserve Premium-now / Free-after-30-days delivery. */
export class MoondreamProvider extends BaseProvider {
  readonly platform: Platform = 'moondream';
  readonly name = 'Moondream';

  private headers(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  }

  private body(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean): Record<string, unknown> {
    if (options?.tools?.length || options?.tool_choice && options.tool_choice !== 'none') {
      throw unsupported('does not support tool calling');
    }
    if (options?.stop?.length) throw unsupported('does not support stop sequences');
    if (options?.response_format) {
      throw unsupported('does not support structured output');
    }
    const input = messages.map(message => {
      if (message.role === 'tool' || message.tool_calls?.length) throw unsupported('does not support tool history');
      const content = Array.isArray(message.content) ? message.content.map(part => {
        if (typeof part === 'string') return { type: 'text', text: part };
        if ((!part.type || part.type === 'text') && typeof part.text === 'string') return { type: 'text', text: part.text };
        if (part.type === 'image_url') {
          const image = part.image_url as { url?: unknown } | undefined;
          if (typeof image?.url === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(image.url)) {
            return { type: 'image_url', image_url: { url: image.url } };
          }
          // Never download arbitrary URLs here (SSRF); callers can supply
          // base64 images or fail over to a provider supporting remote URLs.
          throw unsupported('requires base64 image data URLs, not remote URLs');
        }
        throw unsupported('does not support this content block');
      }) : message.content ?? '';
      // Omit internal reasoning/signature/name/prefill fields on replay.
      return { role: message.role, content };
    });
    return {
      model: modelId, messages: input, stream,
      temperature: options?.temperature, top_p: options?.top_p,
      max_completion_tokens: resolveMaxTokens(this.platform, options?.max_tokens),
      ...(options?.reasoning_effort !== undefined ? { reasoning: options.reasoning_effort !== 'none' } : {}),
      ...(stream && options?.stream_options ? { stream_options: options.stream_options } : {}),
    };
  }

  private record(res: Response, endpoint: string, context?: QuotaObservationContext, modelId?: string): void {
    recordQuotaObservationsFromResponse(res, { ...context, platform: this.platform, endpoint, modelId });
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // /models is public without auth, but rejects invalid Bearer keys (live
    // verified 2026-09-22). Always send auth and reject empty keys locally.
    if (!apiKey.trim()) return { valid: false, error: 'Moondream API key is required' };
    const res = await this.fetchWithTimeout(`${BASE_URL}/models`, { headers: this.headers(apiKey) },
      providerTimeoutMs(this.platform, 30_000), { timeoutBounds: 'request' });
    this.record(res, 'models', quotaContext);
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (!res.ok) throw providerHttpError(res, 'Moondream key validation is temporarily inconclusive');
    const roster = await res.json() as { data?: unknown };
    if (!Array.isArray(roster.data)) throw upstreamError('returned an invalid model roster');
    return true;
  }

  private async request(apiKey: string, messages: ChatMessage[], modelId: string,
    options: CompletionOptions | undefined, stream: boolean, quotaContext?: QuotaObservationContext): Promise<Response> {
    const res = await this.fetchWithTimeout(`${BASE_URL}/chat/completions`, {
      method: 'POST', headers: this.headers(apiKey), body: JSON.stringify(this.body(messages, modelId, options, stream)),
    }, options?.timeoutMs ?? providerTimeoutMs(this.platform, 60_000),
    { signal: options?.signal, timeoutBounds: stream ? 'headers' : 'request' });
    this.record(res, 'chat/completions', quotaContext, modelId);
    if (!res.ok) {
      const text = await res.text();
      let detail: unknown = text;
      try { detail = JSON.parse(text); } catch { /* Preserve non-JSON backoff diagnostics. */ }
      throw providerHttpError(res, `Moondream API error ${res.status}: ${text.slice(0, 500)}`, detail);
    }
    return res;
  }

  async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const res = await this.request(apiKey, messages, modelId, options, false, quotaContext);
    const data = await res.json() as ChatCompletionResponse;
    checkModel(modelId, data?.model);
    if (!data.choices?.length) throw upstreamError('returned no completion choices');
    for (const choice of data.choices) {
      const message = choice.message as ChatMessage & { reasoning?: string };
      if (!message || typeof message.content !== 'string' || !choice.finish_reason) throw upstreamError('returned an invalid completion');
      if (message.reasoning) { message.reasoning_content = message.reasoning; delete message.reasoning; }
      if (!message.content && choice.finish_reason === 'stop') throw upstreamError('returned an empty completion');
    }
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.request(apiKey, messages, modelId, options, true, quotaContext);
    let finished = false;
    for await (const chunk of this.readSseStream(res, { firstByteTimeoutMs: options?.timeoutMs ?? providerTimeoutMs(this.platform, 60_000) })) {
      checkModel(modelId, chunk.model);
      if (!Array.isArray(chunk.choices)) throw upstreamError('returned an invalid stream chunk');
      for (const choice of chunk.choices) {
        if (!choice.delta) throw upstreamError('returned a stream chunk without delta');
        const delta = choice.delta as typeof choice.delta & { reasoning?: string };
        if (delta.reasoning) { delta.reasoning_content = delta.reasoning; delete delta.reasoning; }
        if (choice.finish_reason) finished = true;
      }
      if (!chunk.choices.length && !options?.stream_options?.include_usage) continue;
      yield chunk;
    }
    if (!finished) throw upstreamError('stream ended without a completion finish reason');
  }
}
