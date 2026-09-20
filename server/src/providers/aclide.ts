import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, ChatToolCall, Platform } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { contentToString } from '../lib/content.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { resolveMaxTokens } from '../lib/sampling-params.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

const BASE_URL = 'https://aclide.com/v1';

interface ResponseItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type?: string; text?: string; refusal?: string }[];
  summary?: { text?: string }[];
}

interface AclideResponse {
  id?: string;
  model?: string;
  created_at?: number;
  status?: string;
  output?: ResponseItem[];
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

function upstreamError(message: string): Error {
  return Object.assign(new Error(`ACLIDE ${message}`), { status: 502 });
}

/** ACLIDE exposes Responses, NOT Chat Completions. Streaming clients receive
 * buffered compatibility chunks after a terminal response, as with Sail.
 * No model rows are seeded here: the signed catalog owns the release gate. */
export class AclideProvider extends BaseProvider {
  readonly platform: Platform = 'aclide';
  readonly name = 'ACLIDE';

  private headers(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  }

  private input(messages: ChatMessage[]): Record<string, unknown>[] {
    const input: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.role === 'tool') {
        if (!message.tool_call_id) throw new Error('ACLIDE tool messages require tool_call_id');
        input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: contentToString(message.content) });
        continue;
      }
      let content: unknown = message.content ?? '';
      if (Array.isArray(message.content)) {
        content = message.content.map(part => {
          if (typeof part === 'string' || typeof part.text === 'string') {
            return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: typeof part === 'string' ? part : part.text };
          }
          if (part.type === 'image_url' && message.role === 'user') {
            const image = part.image_url as { url?: string; detail?: string } | undefined;
            if (typeof image?.url === 'string') return { type: 'input_image', image_url: image.url, ...(image.detail ? { detail: image.detail } : {}) };
          }
          // Never silently erase media the caller relied on.
          throw new Error(`ACLIDE does not support this content block: ${part.type ?? 'unknown'}`);
        });
      }
      if (contentToString(message.content) || !message.tool_calls?.length || Array.isArray(content) && content.length) {
        input.push({ role: message.role, content });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
    return input;
  }

  private body(messages: ChatMessage[], modelId: string, options?: CompletionOptions): Record<string, unknown> {
    const maxOutput = resolveMaxTokens(this.platform, options?.max_tokens);
    const format = options?.response_format;
    const body: Record<string, unknown> = { model: modelId, input: this.input(messages), store: false, stream: false };
    if (maxOutput !== undefined) body.max_output_tokens = maxOutput;
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.reasoning_effort) body.reasoning = { effort: options.reasoning_effort };
    if (options?.tools) body.tools = options.tools.map(tool => ({ type: 'function', ...tool.function }));
    if (options?.tool_choice) body.tool_choice = typeof options.tool_choice === 'string'
      ? options.tool_choice : { type: 'function', name: options.tool_choice.function.name };
    if (options?.parallel_tool_calls !== undefined) body.parallel_tool_calls = options.parallel_tool_calls;
    if (format) body.text = { format: format.type === 'json_schema'
      ? { type: 'json_schema', ...format.json_schema } : { type: format.type } };
    return body;
  }

  private record(res: Response, endpoint: string, context?: QuotaObservationContext, modelId?: string): void {
    recordQuotaObservationsFromResponse(res, { ...context, platform: this.platform, modelId, endpoint });
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${BASE_URL}/models`, { headers: this.headers(apiKey) },
      providerTimeoutMs(this.platform, 30_000), { timeoutBounds: 'request' });
    this.record(res, 'models', quotaContext);
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (!res.ok) throw providerHttpError(res, 'ACLIDE key validation is temporarily inconclusive');
    const roster = await res.json() as { data?: unknown };
    if (!Array.isArray(roster.data)) throw upstreamError('returned an invalid model roster');
    return true;
  }

  async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${BASE_URL}/responses`, {
      method: 'POST', headers: this.headers(apiKey), body: JSON.stringify(this.body(messages, modelId, options)),
    }, options?.timeoutMs ?? providerTimeoutMs(this.platform, 120_000), { signal: options?.signal, timeoutBounds: 'request' });
    this.record(res, 'responses', quotaContext, modelId);
    // Preserve HTTP status/backoff even for a non-JSON error page.
    if (!res.ok) {
      const body = await res.text();
      let detail: unknown = body;
      try { detail = JSON.parse(body); } catch { /* Keep non-JSON diagnostics. */ }
      throw providerHttpError(res, `ACLIDE error (HTTP ${res.status})`, detail);
    }
    const response = await res.json() as AclideResponse;
    if (response.model !== modelId) throw upstreamError('returned a different or missing model identity');
    if (!['completed', 'incomplete'].includes(response.status ?? '') || response.error) {
      throw upstreamError(`response failed: ${response.error?.message ?? response.status ?? 'missing status'}`);
    }
    if (!Array.isArray(response.output)) throw upstreamError('returned no output items');
    const parts = response.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []);
    const text = parts.filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
    const refusal = parts.filter(part => part.type === 'refusal').map(part => part.refusal ?? '').join('');
    const reasoning = response.output.filter(item => item.type === 'reasoning')
      .flatMap(item => item.summary ?? []).map(part => part.text ?? '').join('');
    const calls: ChatToolCall[] = response.output.filter(item => item.type === 'function_call').map(item => {
      if (!item.call_id || !item.name || typeof item.arguments !== 'string') throw upstreamError('returned an invalid function call');
      return { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
    });
    const incomplete = response.status === 'incomplete';
    if (!incomplete && !text && !refusal && !calls.length) throw upstreamError('returned an empty completion');
    let finishReason = calls.length ? 'tool_calls' : 'stop';
    if (incomplete) {
      const reason = response.incomplete_details?.reason;
      if (reason !== 'max_output_tokens' && reason !== 'content_filter') throw upstreamError('returned an unknown incomplete status');
      finishReason = reason === 'max_output_tokens' ? 'length' : 'content_filter';
    }
    const usage = response.usage;
    return {
      id: response.id ?? this.makeId(), object: 'chat.completion', created: response.created_at ?? Math.floor(Date.now() / 1000), model: modelId,
      choices: [{ index: 0, message: { role: 'assistant', content: text || refusal,
        ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finishReason }],
      usage: {
        prompt_tokens: usage?.input_tokens ?? 0, completion_tokens: usage?.output_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        ...(usage?.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}),
        ...(usage?.output_tokens_details ? { completion_tokens_details: usage.output_tokens_details } : {}),
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    const result = await this.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    const base = { id: result.id, object: 'chat.completion.chunk' as const, created: result.created, model: result.model };
    const choice = result.choices[0];
    const { content, tool_calls: calls, reasoning_content: reasoning } = choice.message;
    // Do not emit a role chunk until model identity and terminal status pass.
    yield { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    if (reasoning) yield { ...base, choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] };
    if (content) yield { ...base, choices: [{ index: 0, delta: { content: contentToString(content) }, finish_reason: null }] };
    if (calls?.length) yield { ...base, choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({ ...call, index })) }, finish_reason: null }] };
    yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] };
    if (options?.stream_options?.include_usage) yield { ...base, choices: [], usage: result.usage };
  }
}
