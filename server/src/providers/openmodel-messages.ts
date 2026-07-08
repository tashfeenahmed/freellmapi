import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { flattenMessageContent } from '../lib/content.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

/**
 * OpenModel uses Anthropic Messages protocol for all models.
 * Convert between OpenAI chat-completions format (client side) and
 * Anthropic messages format (OpenModel side).
 */
export class OpenModelMessagesProvider extends BaseProvider {
  readonly platform = 'openmodel' as const;
  readonly name = 'OpenModel';
  readonly baseUrl = 'https://api.openmodel.ai/v1';

  _anthropicToOpenAI(data: any, modelId: string): ChatCompletionResponse {
    const contentBlocks = data.content || [];
    const textBlock = contentBlocks.find((b: any) => b.type === 'text');
    const content = textBlock ? textBlock.text : '';
    return {
      id: data.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: data.stop_reason || 'stop',
      }],
      usage: {
        prompt_tokens: data.usage?.input_tokens ?? 0,
        completion_tokens: data.usage?.output_tokens ?? 0,
        total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      _routed_via: { platform: 'openmodel', model: modelId },
    } as ChatCompletionResponse;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: flattenMessageContent(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens ?? 4096,
      top_p: options?.top_p,
      stop: options?.stop,
    };
    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, options?.timeoutMs);
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'messages',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `OpenModel API error ${res.status}: ${(err as any).error?.msg ?? (err as any).error?.message ?? res.statusText}`);
    }
    const data = await res.json();
    return this._anthropicToOpenAI(data, modelId);
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: flattenMessageContent(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens ?? 4096,
      top_p: options?.top_p,
      stop: options?.stop,
      stream: true,
    };
    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, options?.timeoutMs);
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'messages',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `OpenModel API error ${res.status}: ${(err as any).error?.msg ?? (err as any).error?.message ?? res.statusText}`);
    }
    yield* this._anthropicStreamToOpenAI(res, modelId);
  }

  async validateKey(
    apiKey: string,
    quotaContext?: QuotaObservationContext,
  ): Promise<boolean> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 10000);
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId: quotaContext?.modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'models',
    });
    return res.status !== 401 && res.status !== 403;
  }

  protected async *_anthropicStreamToOpenAI(res: Response, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const raw = line.slice(6);
          if (raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'content_block_delta') {
              const text = evt.delta?.text ?? '';
              yield {
                id: '',
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{ index: 0, delta: { content: text } }],
              } as ChatCompletionChunk;
            }
          } catch {}
        }
      }
    }
  }
}
