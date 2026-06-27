import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { proxyFetch } from '../lib/proxy.js';

/** A provider HTTP error carrying the upstream status and, when the response
 *  included a Retry-After header, the parsed delay so the router can bench the
 *  key for at least that long. */
export interface ProviderHttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into a
 *  millisecond delay. Returns undefined when absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Build an error for a non-OK upstream response, capturing the status and any
 *  Retry-After hint. Used by every provider adapter so the proxy can honor a
 *  provider's explicit back-off when it sets the cooldown. */
export function providerHttpError(res: Response, message: string): ProviderHttpError {
  const err = new Error(message) as ProviderHttpError;
  err.status = res.status;
  const retryAfterMs = parseRetryAfterMs(res.headers?.get('retry-after'));
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  /** Per-call HTTP timeout override. Not part of the OpenAI wire format (it is
   * stripped before the request body is built); used by the probe script so
   * NVIDIA's 15-60s serverless cold starts don't read as failures. */
  timeoutMs?: number;
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;
  /** Providers whose free tier needs no API key (e.g. Kilo's anonymous gateway).
   * When true, the gateway stores a sentinel key row so routing still considers
   * the platform "configured", and the provider omits the Authorization header
   * on outgoing requests. Defaults to false; set by subclasses. */
  keyless = false;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean>;

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await proxyFetch(url, { ...init, signal: controller.signal }, this.platform);
    } finally {
      clearTimeout(timeout);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Shared SSE reader for OpenAI-wire streaming endpoints (#231 audit).
   *
   * Hardened against the upstream failure modes observed live:
   *  - Inactivity timeout: fetchWithTimeout's abort timer dies the moment
   *    response HEADERS arrive, so a provider that stalls mid-body used to
   *    hang the client forever. Each read now has its own deadline.
   *  - Abrupt EOF: a stream that ends without `[DONE]` AND without any
   *    `finish_reason` is a truncated generation, not a completion. It used
   *    to end the generator silently (truncation logged as success); it now
   *    throws a retryable error so the proxy can fail over or report it.
   *    Providers that skip `[DONE]` but do send a terminal finish_reason
   *    (several compat shims) still complete normally.
   *
   * Malformed data lines are skipped, matching previous behavior.
   */
  protected async *readSseStream(
    res: Response,
    inactivityTimeoutMs = 90000,
  ): AsyncGenerator<ChatCompletionChunk> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let sawFinishReason = false;

    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${this.name} stream stalled: no data for ${inactivityTimeoutMs}ms (timeout)`)),
              inactivityTimeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(timer));

        const { done, value } = result;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          try {
            const chunk = JSON.parse(data) as ChatCompletionChunk;
            if (chunk.choices?.some(c => c.finish_reason != null)) sawFinishReason = true;
            yield chunk;
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* upstream already gone */ });
    }

    if (!sawFinishReason) {
      throw new Error(`${this.name} stream ended unexpectedly (no [DONE], no finish_reason) — connection reset or truncated upstream`);
    }
  }
}
