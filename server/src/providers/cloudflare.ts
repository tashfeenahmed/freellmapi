import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { contentToString } from '../lib/content.js';

/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */
export class CloudflareProvider extends BaseProvider {
  readonly platform = 'cloudflare' as const;
  readonly name = 'Cloudflare Workers AI';

  private parseKey(apiKey: string): { accountId: string; token: string } {
    const sep = apiKey.indexOf(':');
    if (sep === -1) throw new Error('Cloudflare key must be in format "account_id:api_token"');
    return { accountId: apiKey.slice(0, sep), token: apiKey.slice(sep + 1) };
  }

  // Cloudflare's OpenAI-compat endpoint:
  //   - rejects `content: null` on assistant messages that carry tool_calls,
  //     even though the OpenAI spec allows it (collapse to '');
  //   - doesn't accept the array content envelope, so flatten to string.
  private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => ({ ...m, content: contentToString(m.content) }));
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: 'cloudflare', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`);
    }

    yield* this.readSseStream(res);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed bad/inactive tokens disable.
    const { token } = this.parseKey(apiKey);
    const res = await this.fetchWithTimeout(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
      10000,
    );
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return true; // unexpected non-2xx that isn't auth — don't disable
    const data = await res.json() as any;
    return data.success === true && data.result?.status === 'active';
  }
}
