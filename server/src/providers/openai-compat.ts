import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { rescueInlineToolCalls } from '../lib/tool-call-rescue.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';

/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  private readonly timeoutMs: number;
  /** NVIDIA NIM models reject any request that permits parallel tool calls with
   * `400 This model only supports single tool-calls at once!`. When set, pin
   * parallel_tool_calls to false whenever tools are in play. See issue #255. */
  private readonly forceSingleToolCall: boolean;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
    validateUrl?: string;
    timeoutMs?: number;
    keyless?: boolean;
    forceSingleToolCall?: boolean;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.keyless = opts.keyless ?? false;
    this.forceSingleToolCall = opts.forceSingleToolCall ?? false;
  }

  /** Resolve the parallel_tool_calls flag to send upstream. For providers that
   * only accept single tool calls (NVIDIA NIM), force `false` whenever tools are
   * present so the model never tries to emit two at once and 400s; otherwise pass
   * the caller's value through unchanged. See issue #255. */
  private resolveParallelToolCalls(options?: CompletionOptions): boolean | undefined {
    if (this.forceSingleToolCall && options?.tools && options.tools.length > 0) return false;
    return options?.parallel_tool_calls;
  }

  /** Some providers (Groq especially) reject a model's tool call with a 400
   * `tool_use_failed` when the model emitted it as inline DIALECT TEXT
   * (`<function=NAME{...}</function>`, Hermes/Qwen XML, etc.) that the provider's
   * own parser couldn't convert — but they hand back the raw text in
   * `error.failed_generation`. Weaker tool models (e.g. groq llama-3.3-70b) hit
   * this constantly, dead-ending an agent's whole turn even though the call is
   * perfectly recoverable. Reuse the same inline-dialect rescue the proxy already
   * applies to streamed text: parse `failed_generation` into structured
   * tool_calls so the turn succeeds instead of failing over (or exhausting the
   * chain when every enabled tool model behaves the same way). See issue #264. */
  private rescueFailedGeneration(errBody: unknown, options?: CompletionOptions): ChatToolCall[] | null {
    const failed = (errBody as { error?: { failed_generation?: unknown } })?.error?.failed_generation;
    if (typeof failed !== 'string' || failed.length === 0) return null;
    const toolNames = new Set((options?.tools ?? []).map(t => t.function.name));
    if (toolNames.size === 0) return null;
    const rescue = rescueInlineToolCalls(failed, toolNames);
    if (!rescue.detected || !rescue.calls?.length) return null;
    const schemas = toolSchemaMap(options?.tools);
    return rescue.calls.map((c, i) => ({
      id: `call_rescued_${i + 1}`,
      type: 'function' as const,
      function: { name: c.name, arguments: repairToolArguments(c.arguments, schemas.get(c.name)) },
    }));
  }

  /** Keyless providers (Kilo's anonymous free tier) must send NO Authorization
   * header — a stored sentinel like `Bearer no-key` could be treated as an
   * invalid key. Everyone else sends the bearer as usual. */
  private authHeader(apiKey: string): Record<string, string> {
    return this.keyless ? {} : { 'Authorization': `Bearer ${apiKey}` };
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.authHeader(apiKey),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: this.resolveParallelToolCalls(options),
      }),
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const rescued = this.rescueFailedGeneration(err, options);
      if (rescued) {
        console.log(`[${this.name}] Rescued ${rescued.length} inline tool call(s) from a ${res.status} tool_use_failed (#264)`);
        const out: ChatCompletionResponse = {
          id: `chatcmpl-rescued-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, message: { role: 'assistant', content: null as unknown as string, tool_calls: rescued }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        out._routed_via = { platform: this.platform, model: modelId };
        return out;
      }
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    let data: ChatCompletionResponse;
    try {
      data = await res.json() as ChatCompletionResponse;
    } catch {
      // A 200 whose body isn't a single JSON document — typically a base URL
      // pointing at a non-OpenAI-compatible API (e.g. Ollama's native NDJSON
      // /api endpoints instead of /v1, #189). Surface what's wrong instead of
      // the raw JSON.parse position error.
      throw new Error(
        `${this.name} returned 200 with a non-JSON body — the endpoint is not OpenAI-compatible. ` +
        `Check the base URL (for Ollama use http://host:11434/v1, for llama.cpp/vLLM/LM Studio the /v1 path).`,
      );
    }
    normalizeChoices(data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.authHeader(apiKey),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: this.resolveParallelToolCalls(options),
        stream: true,
      }),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const rescued = this.rescueFailedGeneration(err, options);
      if (rescued) {
        console.log(`[${this.name}] Rescued ${rescued.length} inline tool call(s) from a ${res.status} tool_use_failed (stream, #264)`);
        const base = { id: `chatcmpl-rescued-${Date.now()}`, object: 'chat.completion.chunk' as const, created: Math.floor(Date.now() / 1000), model: modelId };
        yield { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
        yield { ...base, choices: [{ index: 0, delta: { tool_calls: rescued.map((c, i) => ({ index: i, ...c })) as unknown as ChatToolCall[] }, finish_reason: null }] };
        yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
        return;
      }
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    yield* this.readSseStream(res);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Note: transport errors (DNS / timeout / TLS) propagate to the caller.
    // health.ts catches them and marks status='error' WITHOUT incrementing
    // the consecutive-failure counter — only confirmed 401/403 disables a key.
    const url = this.validateUrl ?? `${this.baseUrl}/models`;
    // 30s (not 10s): some upstreams return a large /v1/models catalog that
    // takes >10s from high-latency regions (e.g. NVIDIA NIM measured ~11.2s
    // from India). A 10s cap aborted those calls and health.ts marked a
    // perfectly good key status='error'. 30s aligns with chatCompletion's
    // own slow-upstream allowance and costs nothing for fast providers.
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        ...this.authHeader(apiKey),
        ...this.extraHeaders,
      },
    }, 30000);
    return res.status !== 401 && res.status !== 403;
  }
}

/**
 * Some providers (Z.ai glm-4.5-flash, Cloudflare DeepSeek-R1-distill, others)
 * return reasoning models' actual answer in `message.reasoning_content` with
 * `message.content === ""`. Fold reasoning_content into content so OpenAI-
 * compatible clients see a non-empty assistant message.
 *
 * Other providers (Mistral magistral-medium) return `message.content` as an
 * array of text segments instead of a string. Flatten to string.
 */
function normalizeChoices(data: ChatCompletionResponse): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message as ChatMessage & {
      reasoning_content?: string;
      reasoning?: string;
      content: unknown;
    };
    // Flatten array content (Mistral magistral) → join text segments.
    if (Array.isArray(msg.content)) {
      msg.content = (msg.content as Array<{ text?: string; type?: string }>)
        .map(seg => (typeof seg === 'string' ? seg : (seg.text ?? '')))
        .join('');
    }
    // Fold reasoning into content if content is empty AND there are no
    // tool_calls. With tool_calls present, content=null is the correct OpenAI
    // shape; folding reasoning would confuse clients that branch on content.
    // Field naming varies by provider: Z.ai uses `reasoning_content`, Ollama
    // uses `reasoning`. Prefer `reasoning_content` when both are set.
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
      const fold = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
        ? msg.reasoning_content
        : (typeof msg.reasoning === 'string' && msg.reasoning.length > 0 ? msg.reasoning : null);
      if (fold !== null) msg.content = fold;
    }
  }
}
