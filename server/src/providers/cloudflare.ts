import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { contentToString } from '../lib/content.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

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
    quotaContext?: QuotaObservationContext,
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
        stop: options?.stop,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      }),
    });
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'chat/completions',
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
    quotaContext?: QuotaObservationContext,
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
        stop: options?.stop,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
      }),
    });
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'chat/completions',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`);
    }

    yield* this.readSseStream(res);
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed bad/inactive tokens disable.
    const { accountId, token } = this.parseKey(apiKey);

    // Account-scoped Workers AI tokens 403 on /user/tokens/verify; they can only
    // self-verify via /accounts/{id}/tokens/verify. User-scoped tokens are the
    // opposite. Try the self-verify endpoint first, then fall back to the
    // account-scoped one before treating an auth failure as a bad key. (#297)
    const userResult = await this.verifyAt(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      token,
      quotaContext,
    );
    if (userResult !== 'auth-failed') return userResult;

    const accountResult = await this.verifyAt(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
      token,
      quotaContext,
    );
    if (accountResult === 'auth-failed') return false;
    return accountResult;
  }

  // Hits a Cloudflare token-verify endpoint. Returns true/false for a definitive
  // active/inactive verdict, or 'auth-failed' when the token lacks access to
  // THIS endpoint (401/403) so the caller can try the other scope.
  private async verifyAt(url: string, token: string, quotaContext?: QuotaObservationContext): Promise<boolean | 'auth-failed'> {
    const res = await this.fetchWithTimeout(
      url,
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
      10000,
    );
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId: quotaContext?.modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'tokens/verify',
    });
    if (res.status === 401 || res.status === 403) return 'auth-failed';
    if (!res.ok) return true; // unexpected non-2xx that isn't auth — don't disable
    const data = await res.json() as any;
    return data.success === true && data.result?.status === 'active';
  }
}
