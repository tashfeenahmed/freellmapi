import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult, type KeyValidationFailure } from './base.js';
import { extendedBodyParams, resolveMaxTokens } from '../lib/sampling-params.js';
import { contentToString, contentHasImage } from '../lib/content.js';
import { extractThinkFromMessage } from '../lib/think-tags.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { estimateInputTokens } from '../lib/content.js';
import { startCloudflareCall, type CloudflareNeuronCall } from '../services/cloudflare-neurons.js';

/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */

// Workers AI hosts reasoning models (@cf/zai-org/glm-4.7-flash) that spend
// well over the 15s fetch default before the first byte (live sweep
// 2026-07-11: repeated 15s aborts). Matches zhipu/agnes/ollama bumps.
// PROVIDER_TIMEOUT_CLOUDFLARE overrides (#547).
const CHAT_TIMEOUT_MS = providerTimeoutMs('cloudflare', 60_000);
const GLM_47_FLASH_TIMEOUT_MS = 200_000;

export class CloudflareProvider extends BaseProvider {
  readonly platform = 'cloudflare' as const;
  readonly name = 'Cloudflare Workers AI';

  private timeoutFor(modelId: string, override?: number): number {
    if (override !== undefined) return override;
    if (CHAT_TIMEOUT_MS <= 0) return CHAT_TIMEOUT_MS;
    return modelId === '@cf/zai-org/glm-4.7-flash'
      ? Math.max(CHAT_TIMEOUT_MS, GLM_47_FLASH_TIMEOUT_MS)
      : CHAT_TIMEOUT_MS;
  }

  // Charge the call's estimated neurons before it goes out (#neurons): on
  // Workers Paid nothing upstream stops a run once the free 10K/day is gone,
  // so the meter does. Throws the Free plan's own "daily free allocation" 429
  // when the account has no room left, which benches the account until
  // midnight UTC through the ordinary failure path.
  private meterCall(apiKey: string, modelId: string, messages: ChatMessage[], options: CompletionOptions | undefined, maxTokens: number | undefined): { meter: CloudflareNeuronCall; inputTokens: number } {
    const inputTokens = estimateInputTokens(messages, options?.tools);
    return { meter: startCloudflareCall(apiKey, modelId, { inputTokens, maxOutputTokens: maxTokens }), inputTokens };
  }

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
    return messages.map(m => ({
      ...m,
      content: m.role === 'user' && contentHasImage(m.content)
        ? m.content
        : contentToString(m.content),
    }));
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
    const maxTokens = resolveMaxTokens(this.platform, options?.max_tokens, options?.contextBudget);
    const { meter, inputTokens } = this.meterCall(apiKey, modelId, messages, options, maxTokens);

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
        max_tokens: maxTokens,
        top_p: options?.top_p,
        stop: options?.stop,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        ...extendedBodyParams(this.platform, options),
      }),
      // 'request' bounds: the deadline covers the body read too, so a 200
      // whose body hangs aborts instead of stalling res.json() forever.
    }, this.timeoutFor(modelId, options?.timeoutMs), { signal: options?.signal, timeoutBounds: 'request' });
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'chat/completions',
    });

    if (!res.ok) {
      // An error answer ran no inference, so it bills no neurons.
      meter.refund();
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`, err);
    }

    const data = await res.json() as ChatCompletionResponse;
    meter.settle(data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? inputTokens, outputTokens: data.usage.completion_tokens ?? 0 }
      : null);
    // Workers AI hosts DeepSeek-style models that inline their reasoning trace
    // as a leading `<think>…</think>` block in content; move it to
    // reasoning_content (no-op for messages without the tag).
    for (const choice of data.choices ?? []) {
      if (choice?.message) extractThinkFromMessage(choice.message);
    }
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
    const maxTokens = resolveMaxTokens(this.platform, options?.max_tokens, options?.contextBudget);
    const { meter, inputTokens } = this.meterCall(apiKey, modelId, messages, options, maxTokens);

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
        max_tokens: maxTokens,
        top_p: options?.top_p,
        stop: options?.stop,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        ...extendedBodyParams(this.platform, options),
        stream: true,
      }),
      // Default 'headers' bounds: the deadline dies at response headers, and
      // the client signal + stall watchdog own the stream from there.
    }, this.timeoutFor(modelId, options?.timeoutMs), { signal: options?.signal });
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'chat/completions',
    });

    if (!res.ok) {
      // An error answer ran no inference, so it bills no neurons.
      meter.refund();
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`, err);
    }

    // First-byte grace (#584): reuse the per-model chat timeout (GLM 4.7
    // Flash's 200s included) as the budget for the first stream read.
    // Settle on the stream's own usage chunk when Cloudflare sends one, else on
    // the streamed text (~4 chars a token). A stream cut short is billed for
    // whatever ran, so it keeps the larger of its estimate and what arrived.
    let usage: ChatCompletionChunk['usage'] | undefined;
    let chars = 0;
    let finished = false;
    try {
      for await (const chunk of this.readSseStream(res, { firstByteTimeoutMs: this.timeoutFor(modelId, options?.timeoutMs) })) {
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices ?? []) {
          const d = choice?.delta;
          if (!d) continue;
          chars += (d.content?.length ?? 0) + (d.reasoning_content?.length ?? 0);
          for (const call of d.tool_calls ?? []) chars += (call.function?.name?.length ?? 0) + (call.function?.arguments?.length ?? 0);
        }
        yield chunk;
      }
      finished = true;
    } finally {
      const streamed = Math.ceil(chars / 4);
      if (usage) {
        meter.settle({ inputTokens: usage.prompt_tokens ?? inputTokens, outputTokens: usage.completion_tokens ?? streamed });
      } else if (finished) {
        meter.settle({ inputTokens, outputTokens: streamed });
      } else {
        meter.settleAtLeast({ inputTokens, outputTokens: streamed });
      }
    }
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
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
    if ('result' in userResult) return userResult.result;

    const accountResult = await this.verifyAt(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
      token,
      quotaContext,
    );
    if ('result' in accountResult) return accountResult.result;
    return accountResult.authFailed;
  }

  // Hits a Cloudflare token-verify endpoint. Returns {result} for a definitive
  // verdict, or {authFailed} when the token lacks access to THIS endpoint
  // (401/403) so the caller can try the other scope — carrying the upstream
  // reason so a key that fails both scopes still surfaces why.
  private async verifyAt(url: string, token: string, quotaContext?: QuotaObservationContext): Promise<{ result: KeyValidationResult } | { authFailed: KeyValidationFailure }> {
    const res = await this.fetchWithTimeout(
      url,
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
      10000,
      { timeoutBounds: 'request' },
    );
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId: quotaContext?.modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'tokens/verify',
    });
    if (res.status === 401 || res.status === 403) {
      return { authFailed: await this.validationResult(res) as KeyValidationFailure };
    }
    if (!res.ok) return { result: true }; // unexpected non-2xx that isn't auth — don't disable
    const data = await res.json() as any;
    if (data.success === true && data.result?.status === 'active') return { result: true };
    const reason = data.result?.status
      ? `token status is "${data.result.status}"`
      : data.errors?.[0]?.message ?? 'verify endpoint did not confirm an active token';
    return { result: { valid: false, error: `${this.name} key validation failed: ${reason}` } };
  }
}
