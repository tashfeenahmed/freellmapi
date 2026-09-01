import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  Platform,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import {
  BaseProvider,
  providerHttpError,
  type CompletionOptions,
  type KeyValidationResult,
} from './base.js';
import { contentToString } from '../lib/content.js';
import { resolveMaxTokens } from '../lib/sampling-params.js';
import {
  recordQuotaObservationsFromResponse,
  type QuotaObservationContext,
} from '../services/provider-quota.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';

const BASE_URL = 'https://api.sailresearch.com/v1';
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const POLL_REQUEST_TIMEOUT_MS = 30_000;

// Sail serves these models only through its best-effort flex completion window.
// Flex requests must use the Responses API in background mode and be polled.
const FLEX_ONLY_MODELS = new Set([
  'Qwen/Qwen3.6-35B-A3B',
  'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16',
]);

type SailStatus = 'queued' | 'in_progress' | 'completed' | 'incomplete' | 'failed' | 'cancelled';

interface SailUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface SailOutputContent {
  type?: string;
  text?: string;
}

interface SailOutputItem {
  id?: string;
  type?: string;
  role?: string;
  content?: SailOutputContent[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface SailResponse {
  id?: string;
  model?: string;
  created_at?: number;
  status?: SailStatus;
  output?: SailOutputItem[];
  usage?: SailUsage;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

interface SailProviderOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Sail Research adapter.
 *
 * Sail's stable surface is the OpenAI Responses API, not streaming Chat
 * Completions. Every request is submitted with `background: true`, then polled
 * until terminal. That is required for its flex-only models and avoids proxy
 * timeouts for core models that spend several minutes queued. The completed
 * Responses object is normalized back into FreeLLMAPI's Chat Completions shape;
 * streaming callers receive a small synthesized role/content/finish sequence.
 */
export class SailProvider extends BaseProvider {
  readonly platform: Platform = 'sail';
  readonly name = 'Sail Research';
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: SailProviderOptions = {}) {
    super();
    this.timeoutMs = providerTimeoutMs('sail', options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private authHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private completionWindow(modelId: string): 'asap' | 'flex' {
    return FLEX_ONLY_MODELS.has(modelId) ? 'flex' : 'asap';
  }

  private reasoningEffort(modelId: string, options?: CompletionOptions): string | undefined {
    const requested = options?.reasoning_effort;
    if (!requested) return undefined;
    // Live API validation: gpt-oss rejects none/minimal and accepts
    // low/medium/high/xhigh/max. Clamp the two weaker OpenAI spellings to low.
    if (modelId === 'openai/gpt-oss-120b' && (requested === 'none' || requested === 'minimal')) {
      return 'low';
    }
    return requested;
  }

  /** Translate Chat Completions history into Responses input items. */
  private inputItems(messages: ChatMessage[]): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      const text = contentToString(message.content);
      if (message.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id ?? message.name ?? 'unknown_call',
          output: text,
        });
        continue;
      }

      if (text || !message.tool_calls?.length) {
        input.push({ role: message.role, content: text });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    }
    return input;
  }

  private toolChoice(choice: ChatToolChoice | undefined): unknown {
    if (!choice || typeof choice === 'string') return choice;
    return { type: 'function', name: choice.function.name };
  }

  private textFormat(options?: CompletionOptions): Record<string, unknown> | undefined {
    const format = options?.response_format;
    if (!format) return undefined;
    if (format.type === 'json_schema') {
      return {
        type: 'json_schema',
        name: format.json_schema?.name ?? 'response',
        schema: format.json_schema?.schema ?? { type: 'object' },
        strict: format.json_schema?.strict ?? false,
      };
    }
    // Sail rejects Responses `json_object`; preserve the caller's intent with
    // a permissive JSON schema, the supported equivalent.
    return {
      type: 'json_schema',
      name: 'response',
      schema: { type: 'object', additionalProperties: true },
      strict: false,
    };
  }

  private buildBody(messages: ChatMessage[], modelId: string, options?: CompletionOptions): Record<string, unknown> {
    const maxOutputTokens = resolveMaxTokens(this.platform, options?.max_tokens);
    const reasoningEffort = this.reasoningEffort(modelId, options);
    const textFormat = this.textFormat(options);
    const tools = options?.tools?.map(tool => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: tool.function.strict,
    }));

    return {
      model: modelId,
      input: this.inputItems(messages),
      background: true,
      metadata: { completion_window: this.completionWindow(modelId) },
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.top_p !== undefined ? { top_p: options.top_p } : {}),
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(options?.tool_choice !== undefined ? { tool_choice: this.toolChoice(options.tool_choice) } : {}),
      ...(textFormat ? { text: { format: textFormat } } : {}),
      // `stop`, `parallel_tool_calls`, seed/penalties/logprobs and multimodal
      // input are not supported on Sail's stable Responses API.
    };
  }

  private errorText(body: unknown, status: number, statusText: string): string {
    const parsed = body as { error?: { message?: unknown }; detail?: unknown; message?: unknown };
    if (typeof parsed?.error?.message === 'string' && parsed.error.message) return parsed.error.message;
    if (typeof parsed?.detail === 'string' && parsed.detail) return parsed.detail;
    if (typeof parsed?.message === 'string' && parsed.message) return parsed.message;
    return statusText || `HTTP ${status}`;
  }

  private recordQuota(res: Response, modelId: string | undefined, quotaContext?: QuotaObservationContext): void {
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'responses',
    });
  }

  private async parseResponse(res: Response): Promise<SailResponse> {
    const body = await res.json().catch(() => ({})) as SailResponse;
    if (!res.ok) {
      throw providerHttpError(
        res,
        `${this.name} API error ${res.status}: ${this.errorText(body, res.status, res.statusText)}`,
        body,
      );
    }
    return body;
  }

  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal?.aborted) throw signal.reason ?? new Error('Sail request aborted');
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let onAbort: () => void;
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error !== undefined) reject(error);
        else resolve();
      };
      onAbort = () => {
        finish(signal?.reason ?? new Error('Sail request aborted'));
      };
      timer = setTimeout(() => finish(), ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async runResponse(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<SailResponse> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();
    const remaining = () => timeoutMs <= 0 ? POLL_REQUEST_TIMEOUT_MS : Math.max(1, timeoutMs - (Date.now() - startedAt));
    const requestTimeout = () => Math.min(POLL_REQUEST_TIMEOUT_MS, remaining());

    const submit = await this.fetchWithTimeout(`${BASE_URL}/responses`, {
      method: 'POST',
      headers: this.authHeaders(apiKey),
      body: JSON.stringify(this.buildBody(messages, modelId, options)),
    }, requestTimeout(), { signal: options?.signal, timeoutBounds: 'request' });
    this.recordQuota(submit, modelId, quotaContext);
    let response = await this.parseResponse(submit);

    if (!response.id) throw new Error(`${this.name} returned no response id`);
    const responseId = response.id;
    while (response.status === 'queued' || response.status === 'in_progress') {
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        throw new Error(`${this.name} response ${responseId} did not complete within ${timeoutMs}ms`);
      }
      await this.wait(Math.min(this.pollIntervalMs, remaining()), options?.signal);
      const poll = await this.fetchWithTimeout(`${BASE_URL}/responses/${encodeURIComponent(responseId)}`, {
        method: 'GET',
        headers: this.authHeaders(apiKey),
      }, requestTimeout(), { signal: options?.signal, timeoutBounds: 'request' });
      this.recordQuota(poll, modelId, quotaContext);
      response = await this.parseResponse(poll);
    }

    if (response.status === 'failed' || response.status === 'cancelled') {
      const reason = response.error?.message ?? response.status;
      throw new Error(`${this.name} response ${response.id} ${reason}`);
    }
    if (response.status !== 'completed' && response.status !== 'incomplete') {
      throw new Error(`${this.name} returned unexpected response status: ${response.status ?? 'missing'}`);
    }
    return response;
  }

  private usageOf(usage?: SailUsage): TokenUsage {
    return {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      prompt_tokens_details: { cached_tokens: usage?.input_tokens_details?.cached_tokens ?? 0 },
      completion_tokens_details: { reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? 0 },
    };
  }

  private normalize(response: SailResponse, modelId: string): ChatCompletionResponse {
    const text = (response.output ?? [])
      .filter(item => item.type === 'message')
      .flatMap(item => item.content ?? [])
      .filter(content => content.type === 'output_text' && typeof content.text === 'string')
      .map(content => content.text as string)
      .join('');
    const toolCalls: ChatToolCall[] = (response.output ?? [])
      .filter(item => item.type === 'function_call' && typeof item.name === 'string')
      .map((item, index) => ({
        id: item.call_id ?? item.id ?? `call_sail_${index + 1}`,
        type: 'function',
        function: {
          name: item.name as string,
          arguments: item.arguments ?? '{}',
        },
      }));
    const incomplete = response.status === 'incomplete';
    const finishReason = toolCalls.length > 0
      ? 'tool_calls'
      : incomplete && response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop';
    const out: ChatCompletionResponse = {
      id: response.id ?? this.makeId(),
      object: 'chat.completion',
      created: response.created_at ?? Math.floor(Date.now() / 1000),
      model: response.model ?? modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage: this.usageOf(response.usage),
    };
    out._routed_via = { platform: this.platform, model: modelId };
    return out;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    return this.normalize(
      await this.runResponse(apiKey, messages, modelId, options, quotaContext),
      modelId,
    );
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const data = await this.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    const choice = data.choices[0];
    const content = contentToString(choice.message.content);
    const toolCalls = choice.message.tool_calls ?? [];
    const base = {
      id: data.id,
      object: 'chat.completion.chunk' as const,
      created: data.created,
      model: data.model,
    };
    yield { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    if (content) yield { ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
    if (toolCalls.length > 0) {
      yield { ...base, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] };
    }
    yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] };
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${BASE_URL}/models`, {
      method: 'GET',
      headers: this.authHeaders(apiKey),
    }, POLL_REQUEST_TIMEOUT_MS, { timeoutBounds: 'request' });
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'models',
    });
    return this.validationResult(res);
  }
}
