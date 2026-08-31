import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import type { ExtendedSamplingOptions } from '../lib/sampling-params.js';
import { proxyFetch } from '../lib/proxy.js';
import { providerTimeoutMs, streamStallTimeoutMs } from '../lib/provider-timeout.js';
import { extractThinkTagsFromStream } from '../lib/think-tags.js';

/** A provider HTTP error carrying the upstream status and, when the provider
 *  stated one, the parsed back-off so the router can bench the key for at least
 *  that long. The delay may come from the Retry-After header or from the error
 *  body — see providerHttpError. */
export interface ProviderHttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

/** Upper bound on a provider-supplied back-off. A malformed or hostile
 *  `Retry-After` (e.g. 99999999999) would otherwise bench a key effectively
 *  forever, since the value feeds the cooldown expiry directly. A day is longer
 *  than any real free-tier reset window, so clamping cannot mask a genuine hint. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into a
 *  millisecond delay, clamped to MAX_RETRY_AFTER_MS. Returns undefined when
 *  absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    return Math.min(Math.max(0, when - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

/** A protobuf Duration, as google.rpc.RetryInfo spells its `retryDelay`:
 *  digits, an optional fraction, then a literal `s` ("17s", "1.5s", "0.25s"). */
const PROTOBUF_DURATION = /^(\d+(?:\.\d+)?)s$/;

/** "Please try again in 7.66s" / "retry after 30 seconds" / "try again in 2m".
 *  Anchored on an explicit retry phrase so an unrelated number in an error
 *  message can never be mistaken for a back-off. */
const PROSE_RETRY = /(?:try again|retry)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours)\b/i;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};

function clampRetryMs(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** Depth-first search for the first `retryDelay`/`retry_after`-shaped field. The
 *  shape varies by provider and by endpoint within a provider, so walking is
 *  more durable than a list of exact paths — and cheaper to maintain than one
 *  parser per adapter. Depth-capped so a pathological body cannot spin. */
function findStatedDelayMs(node: unknown, depth = 0): number | undefined {
  if (depth > 6 || node === null || typeof node !== 'object') return undefined;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findStatedDelayMs(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (normalized === 'retrydelay' || normalized === 'retryafter' || normalized === 'retryafterseconds') {
      // google.rpc.RetryInfo states "17s"; other providers state bare seconds.
      if (typeof value === 'string') {
        const duration = PROTOBUF_DURATION.exec(value.trim());
        if (duration) return clampRetryMs(Number(duration[1]) * 1000);
        if (/^\d+(\.\d+)?$/.test(value.trim())) return clampRetryMs(Number(value) * 1000);
      }
      if (typeof value === 'number') return clampRetryMs(value * 1000);
    }
    const found = findStatedDelayMs(value, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The back-off a provider stated inside its error BODY, in milliseconds.
 *
 * Not every provider uses the Retry-After header. Gemini answers a 429 with
 * `error.details[]` carrying a `google.rpc.RetryInfo` whose `retryDelay` is
 * "17s", and several OpenAI-compatible tiers only say it in prose. Those hints
 * were being thrown away: the body is flattened to a single message string
 * before it reaches the router, so a provider that told us exactly when to come
 * back got the same heuristic cooldown ladder as one that said nothing.
 */
export function parseStatedRetryMs(body: unknown): number | undefined {
  if (body == null) return undefined;

  if (typeof body !== 'string') {
    const structured = findStatedDelayMs(body);
    if (structured !== undefined) return structured;
  }

  // Prose last: a stated field is a promise, a sentence is an observation.
  const text = typeof body === 'string' ? body : safeStringify(body);
  const prose = text ? PROSE_RETRY.exec(text) : null;
  if (prose) {
    const unit = UNIT_MS[prose[2].toLowerCase()];
    if (unit) return clampRetryMs(Number(prose[1]) * unit);
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return ''; // Circular or otherwise unserialisable — no prose to read.
  }
}

/** Build an error for a non-OK upstream response, capturing the status and any
 *  stated back-off. Used by every provider adapter so the proxy can honor a
 *  provider's explicit hint when it sets the cooldown.
 *
 *  `body` is the already-parsed error payload the caller used to build
 *  `message`. Only a delay is read out of it and only a number is kept — the
 *  body itself is never retained, so nothing extra reaches a log or the
 *  attempt trace. The Retry-After header still wins when both are present: it
 *  is the standard channel, and preferring it keeps existing behavior exactly
 *  as it was. */
export function providerHttpError(res: Response, message: string, body?: unknown): ProviderHttpError {
  const err = new Error(message) as ProviderHttpError;
  err.status = res.status;
  const retryAfterMs = parseRetryAfterMs(res.headers?.get('retry-after')) ?? parseStatedRetryMs(body);
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

// Extended sampling knobs (top_k, seed, penalties, logit_bias, logprobs,
// response_format…) ride along via ExtendedSamplingOptions; adapters forward
// them per the platform policy in lib/sampling-params.ts.
export interface CompletionOptions extends ExtendedSamplingOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  /** Per-call HTTP timeout override. Not part of the OpenAI wire format (it is
   * stripped before the request body is built); used by the probe script so
   * NVIDIA's 15-60s serverless cold starts don't read as failures. */
  timeoutMs?: number;
  /** Abort signal for the gateway's OWN client (request socket closed). The
   * proxy surfaces thread it here so a disconnect cancels the upstream fetch
   * AND any in-progress body/stream read — tokens stop burning and the
   * in-flight lease frees immediately instead of when the read happens to
   * finish. Composed with the per-attempt timeout in fetchWithTimeout; never
   * serialized into the request body. */
  signal?: AbortSignal;
}

/** Per-call abort/timeout wiring for fetchWithTimeout. */
export interface ProviderFetchOptions {
  /** Client-disconnect signal, composed with the per-attempt timeout via
   * AbortSignal.any. Unlike the timeout it is never disarmed at headers, so it
   * also aborts body reads and stream iteration through undici. */
  signal?: AbortSignal;
  /** What the per-attempt timeout bounds:
   *  - 'headers' (default, historical): the abort timer dies the moment
   *    response HEADERS arrive — right for streams, whose body legitimately
   *    outlives any fixed deadline (readSseStream's stall watchdog owns
   *    mid-stream hangs, the client signal owns "nobody is listening").
   *  - 'request': the deadline stays armed across the body read too, so a 200
   *    whose body never finishes aborts at timeoutMs instead of hanging
   *    res.json() forever. Use for non-streaming calls, which read the whole
   *    body as one unit. */
  timeoutBounds?: 'headers' | 'request';
}

/** Per-stream timeout wiring for readSseStream (#584). */
export interface SseStreamOptions {
  /** The chat timeout the adapter gave fetchWithTimeout for this request
   * (options.timeoutMs override included). Becomes the first-byte grace
   * budget, floored at the stall budget — see firstByteBudgetMs. Defaults to
   * fetchWithTimeout's own default, providerTimeoutMs(platform, 15000). */
  firstByteTimeoutMs?: number;
  /** Mid-stream inactivity budget; defaults to streamStallTimeoutMs(platform)
   * (per-platform env > global env > 90s). 0 disables the watchdog. */
  stallTimeoutMs?: number;
}

export interface KeyValidationFailure {
  valid: false;
  /** Provider-supplied reason suitable for health logs and the local keys UI. */
  error: string;
}

export type KeyValidationResult = boolean | KeyValidationFailure;

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

  abstract validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult>;

  /**
   * Turn a conventional 401/403 validation response into a diagnostic result.
   * Providers still return a simple boolean when no useful error body exists,
   * but preserving the upstream message here lets the health service persist
   * and display the reason instead of reducing every failure to "invalid".
   */
  protected async validationResult(res: Response): Promise<KeyValidationResult> {
    if (res.status !== 401 && res.status !== 403) return true;

    let body: any = null;
    try {
      if (typeof (res as any).json === 'function') body = await res.json();
    } catch {
      // A status and provider name are still more useful than no reason.
    }

    const detail = [
      body?.error?.message,
      body?.errors?.[0]?.message,
      body?.message,
      body?.detail,
      body?.title,
      res.statusText,
    ].find((value) => typeof value === 'string' && value.trim().length > 0);

    return {
      valid: false,
      error: `${this.name} key validation failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    };
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    // Adapters that don't pass a timeout inherit the platform's env override
    // (PROVIDER_TIMEOUT_<PLATFORM>, issue #547) over the historical 15s.
    timeoutMs = providerTimeoutMs(this.platform, 15000),
    fetchOpts?: ProviderFetchOptions,
  ): Promise<Response> {
    const signals: AbortSignal[] = [];
    if (fetchOpts?.signal) signals.push(fetchOpts.signal);

    // timeoutMs <= 0 means "no timeout" (PROVIDER_TIMEOUT_<PLATFORM>=0).
    // setTimeout(abort, 0) would abort every request on the next macrotask.
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      signals.push(controller.signal);
      if (fetchOpts?.timeoutBounds === 'request') {
        // Whole-request deadline: stays armed across the body read, so a 200
        // whose body never finishes aborts res.json() at timeoutMs instead of
        // hanging forever. Never cleared — firing after the response is fully
        // consumed is a no-op — and unref'd so a spent request's leftover
        // deadline can't hold the process open.
        timer.unref?.();
      } else {
        // Historical header-only deadline: disarmed the moment response
        // HEADERS arrive (see finally). Streams need this — an SSE body
        // legitimately outlives any fixed deadline, and mid-stream hangs are
        // owned by the stall watchdog (readSseStream) + the client signal.
        headerTimer = timer;
      }
    }

    // Compose the per-attempt timeout with the client-disconnect signal.
    // Unlike the timeout, the client signal is never disarmed: undici ties it
    // to the whole request, so a disconnect also aborts body reads and stream
    // iteration, rejecting them with the marked reason from newClientAbortError.
    const signal = signals.length === 0
      ? init.signal ?? undefined
      : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      // requestType='chat' + timeoutMs makes the AbortError message read
      // `<platform>, chat, 15s` for triage from the requests.error column.
      return await proxyFetch(url, signal ? { ...init, signal } : init, this.platform, 'chat', timeoutMs);
    } finally {
      if (headerTimer !== undefined) clearTimeout(headerTimer);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * One reader.read() bounded by the mid-stream inactivity watchdog (#553).
   * Shared by readSseStream and adapters that parse their own wire format
   * (google.ts) so every stream gets the same stall semantics:
   * PROVIDER_STREAM_STALL_TIMEOUT_MS (per-platform override
   * PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM>, #584), default 90s, 0 disables.
   * Client-abort rejections pass through untouched — undici errors the body
   * with the request signal's reason, so a disconnect surfaces here as the
   * marked error from newClientAbortError, not as a stall. `timeoutMessage`
   * lets the first-byte read report its distinct wording (#584).
   */
  protected async readWithStallTimeout<T>(
    read: () => Promise<T>,
    inactivityTimeoutMs: number,
    timeoutMessage?: string,
  ): Promise<T> {
    if (inactivityTimeoutMs <= 0) return read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(timeoutMessage ?? `${this.name} stream stalled: no data for ${inactivityTimeoutMs}ms (timeout)`)),
          inactivityTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Budget for the FIRST read of a streaming body (issue #584): the platform's
   * chat timeout is already "how slow may the first token be" — tuned per
   * platform at registration and env-overridable via PROVIDER_TIMEOUT_<PLATFORM>
   * — but on streams it is disarmed the moment response HEADERS arrive, and
   * providers like NVIDIA NIM send SSE headers instantly then prefill for
   * minutes. Floored at the stall budget so a platform with a short chat
   * timeout never gets a STRICTER first read than the pre-#584 watchdog gave
   * it. 0 on either side (env-disabled chat timeout, or disabled watchdog)
   * means the first read is unbounded — the client signal still owns
   * "nobody is listening".
   */
  protected firstByteBudgetMs(chatTimeoutMs: number, stallTimeoutMs: number): number {
    if (chatTimeoutMs <= 0 || stallTimeoutMs <= 0) return 0;
    return Math.max(chatTimeoutMs, stallTimeoutMs);
  }

  /** Distinct wording for a first-byte timeout (vs a mid-stream stall) so the
   * attempt-trace error_summary tells slow prefill apart from a dead stream. */
  protected firstByteTimeoutMessage(budgetMs: number): string {
    return `${this.name} stream: no first byte within ${budgetMs}ms (first-byte timeout)`;
  }

  /**
   * Shared SSE reader for OpenAI-wire streaming endpoints (#231 audit).
   *
   * Hardened against the upstream failure modes observed live:
   *  - Inactivity timeout: fetchWithTimeout's abort timer dies the moment
   *    response HEADERS arrive, so a provider that stalls mid-body used to
   *    hang the client forever. Each read now has its own deadline. The FIRST
   *    read gets a grace budget derived from the platform's chat timeout
   *    (#584) — SSE headers can arrive instantly while the model prefills a
   *    long prompt for minutes, which is slow, not stalled.
   *  - Abrupt EOF: a stream that ends without `[DONE]` AND without any
   *    `finish_reason` is a truncated generation, not a completion. It used
   *    to end the generator silently (truncation logged as success); it now
   *    throws a retryable error so the proxy can fail over or report it.
   *    Providers that skip `[DONE]` but do send a terminal finish_reason
   *    (several compat shims) still complete normally.
   *
   * Malformed data lines are skipped, matching previous behavior.
   *
   * The frames additionally pass through the inline `<think>` extractor
   * (lib/think-tags.ts): DeepSeek-style models that serialize their reasoning
   * trace INTO delta.content as a leading `<think>…</think>` block get it
   * moved to delta.reasoning_content, so downstream surfaces never render
   * thinking as answer text. Streams without the tag are forwarded verbatim.
   */
  protected async *readSseStream(
    res: Response,
    opts?: SseStreamOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    yield* extractThinkTagsFromStream(this.readSseFrames(res, opts));
  }

  private async *readSseFrames(
    res: Response,
    opts?: SseStreamOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    // The 90s default was hardcoded and silently truncated slow streams — the
    // gateway ended them with an error frame plus a clean [DONE] that OpenAI
    // SDK clients swallow, so responses "just stopped" (issue #553). Operators
    // proxying slow free tiers can raise it (or 0 to disable) via
    // PROVIDER_STREAM_STALL_TIMEOUT_MS, or per platform via
    // PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM> (#584).
    const inactivityTimeoutMs = opts?.stallTimeoutMs ?? streamStallTimeoutMs(this.platform);
    // First-byte grace (#584): adapters pass the same chat timeout they gave
    // fetchWithTimeout; the fallback mirrors fetchWithTimeout's own default so
    // adapters that never tuned either stay on max(15s-or-env, stall) — i.e.
    // exactly the stall budget they had before.
    const chatTimeoutMs = opts?.firstByteTimeoutMs ?? providerTimeoutMs(this.platform, 15000);
    const firstByteMs = this.firstByteBudgetMs(chatTimeoutMs, inactivityTimeoutMs);

    const decoder = new TextDecoder();
    let buffer = '';
    let sawFinishReason = false;
    let awaitingFirstByte = true;

    try {
      while (true) {
        const { done, value } = awaitingFirstByte
          ? await this.readWithStallTimeout(() => reader.read(), firstByteMs, this.firstByteTimeoutMessage(firstByteMs))
          : await this.readWithStallTimeout(() => reader.read(), inactivityTimeoutMs);
        awaitingFirstByte = false;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).replace(/^ /, '');
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
