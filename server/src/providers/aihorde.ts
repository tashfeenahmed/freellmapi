import type {
  ChatMessage,
  ChatContent,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

/**
 * AI Horde — free, community-powered inference served by volunteer workers and
 * exposed through an OpenAI-compatible proxy at https://oai.aihorde.net/v1
 * (issue #345).
 *
 * It is deliberately NOT a plain OpenAICompatProvider: the proxy diverges from
 * the OpenAI contract in ways that would otherwise 422 or corrupt analytics,
 * all handled here:
 *
 *  - QUEUED execution. A request waits for whatever volunteer workers are
 *    online, so a single call can take tens of seconds to minutes. Hence the
 *    120s timeout and the no-upstream-streaming design — one queued generation,
 *    surfaced whole (streamChatCompletion emits it as a single delta).
 *  - `max_tokens` must be >= 16 or the proxy 422s. We floor it, and default it
 *    when the caller omits it so a worker doesn't run to its own (often large)
 *    internal cap on every call.
 *  - `stop` must be an ARRAY; a bare string 422s. We wrap it.
 *  - No tool / function calling. tools, tool_choice and parallel_tool_calls are
 *    dropped so a tool-using caller doesn't 422 the whole request.
 *  - `usage` comes back as `{"kudos": N}` with no token counts. We synthesize
 *    prompt/completion/total token estimates (chars/4) so analytics, savings
 *    math and per-model usage charts aren't uniformly zero.
 *  - Auth: anonymous access works with the documented sentinel key `0000000000`
 *    (lowest queue priority). Registered keyless so the gateway auto-configures
 *    it; a real aihorde.net key stored on the api_keys row is forwarded instead
 *    for higher priority (see resolveBearer).
 *
 * Quality caveat (not fixable here): some workers append template/instruction
 * text after the answer. Surfaced verbatim; documented as a catalog quirk.
 */
const ANON_KEY = '0000000000';
const MIN_MAX_TOKENS = 16;
const DEFAULT_MAX_TOKENS = 512;
const HORDE_TIMEOUT_MS = 120000;

/** Rough token estimate (~4 chars/token) used only to fill usage when the proxy
 * returns kudos instead of token counts. Good enough for analytics, never
 * billed against anything. Handles string | null | multimodal-array content. */
function estimateTokens(content: ChatContent | undefined): number {
  if (content == null) return 0;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else {
    text = content
      .map(block => (typeof block === 'string' ? block : (block?.text ?? '')))
      .join(' ');
  }
  return Math.ceil(text.length / 4);
}

export class AIHordeProvider extends BaseProvider {
  readonly platform: Platform = 'aihorde';
  readonly name = 'AI Horde';
  /** Works out of the box via the anonymous key: the gateway stores a sentinel
   * row (so routing treats the platform as configured) and we send the anon
   * bearer. A stored real horde key replaces the sentinel for higher priority. */
  keyless = true;
  private readonly baseUrl = 'https://oai.aihorde.net/v1';

  /** Map the stored credential to the bearer we send upstream. The keyless flow
   * stores `'no-key'` (or nothing) for the anonymous case → send AI Horde's
   * documented anonymous key. Any other stored value is treated as a registered
   * key and forwarded verbatim for higher queue priority. */
  private resolveBearer(apiKey: string): string {
    const k = apiKey?.trim();
    if (!k || k === 'no-key' || k === ANON_KEY) return ANON_KEY;
    return k;
  }

  /** Build the upstream body, normalizing the OpenAI params the proxy rejects
   * (see class doc). No `stream` — we never stream upstream. */
  private buildBody(messages: ChatMessage[], modelId: string, options?: CompletionOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      // Floor at 16 (proxy 422s below it); default when omitted.
      max_tokens: Math.max(MIN_MAX_TOKENS, options?.max_tokens ?? DEFAULT_MAX_TOKENS),
    };
    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.top_p != null) body.top_p = options.top_p;
    // `stop` must be an array; wrap a bare string, pass arrays through.
    if (options?.stop != null) {
      body.stop = Array.isArray(options.stop) ? options.stop : [options.stop];
    }
    // tools / tool_choice / parallel_tool_calls intentionally dropped: no tool support.
    return body;
  }

  /** Replace the proxy's `{"kudos": N}` usage with synthesized token counts so
   * downstream analytics aren't all zero. Prompt from the input messages,
   * completion from the returned content. */
  private synthesizeUsage(messages: ChatMessage[], data: ChatCompletionResponse): void {
    const prompt = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const completion = (data.choices ?? []).reduce(
      (sum, c) => sum + estimateTokens(c.message?.content),
      0,
    );
    data.usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
  }

  private parseError(err: unknown, status: number, statusText: string): string {
    // AI Horde errors are `{"detail": "..."}`; fall back to OpenAI's
    // `{error:{message}}` shape and then the status line.
    const detail = (err as { detail?: unknown })?.detail;
    if (typeof detail === 'string' && detail.length > 0) return detail;
    const msg = (err as { error?: { message?: unknown } })?.error?.message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
    return statusText || `HTTP ${status}`;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.resolveBearer(apiKey)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(messages, modelId, options)),
    }, options?.timeoutMs ?? HORDE_TIMEOUT_MS);

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
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${this.parseError(err, res.status, res.statusText)}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    this.synthesizeUsage(messages, data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  /**
   * AI Horde's proxy returns a queued generation as one response, so there is no
   * meaningful token-by-token stream. We run the same blocking call and emit the
   * result as a minimal SSE sequence (role → content → finish) so streaming
   * clients still work.
   */
  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const data = await this.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    const choice = data.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const base = {
      id: data.id ?? this.makeId(),
      object: 'chat.completion.chunk' as const,
      created: data.created ?? Math.floor(Date.now() / 1000),
      model: modelId,
    };
    yield { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    if (content) {
      yield { ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
    }
    yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? 'stop' }] };
  }

  /**
   * The OpenAI proxy's GET /v1/models answers 200 for ANY bearer (it does not
   * validate the key), and the anonymous key is always usable, so a reachable
   * endpoint means the platform is healthy. Mirrors keyless providers: only a
   * confirmed 401/403 is treated as an invalid key. Transport errors propagate
   * to health.ts (marked status='error' without counting a failure).
   */
  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.resolveBearer(apiKey)}` },
    }, 30000);
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'models',
    });
    return res.status !== 401 && res.status !== 403;
  }
}
