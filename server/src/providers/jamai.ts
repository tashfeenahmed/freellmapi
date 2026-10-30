import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, Platform } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { resolveMaxTokens } from '../lib/sampling-params.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

export const JAMAI_BASE_URL = 'https://api.jamaibase.com/api/v1';
const upstreamError = (message: string) => Object.assign(new Error(`JamAI ${message}`), { status: 502 });

/** The UI collects two fields; the existing encrypted credential stores both.
 * Export/import format: JAMAI_KEY=proj_…:jamai_pat_… . Never put either in a URL.
 * Model rows live only in the signed catalog, not application seeds. */
export function jamaiHeaders(credential: string): Record<string, string> {
  const match = /^(proj_[A-Za-z0-9_-]+):(jamai_pat_[A-Za-z0-9_-]+)$/.exec(credential.trim());
  if (!match) throw Object.assign(new Error('JamAI requires a project ID and PAT in project_id:PAT form'), { status: 401 });
  return { Authorization: `Bearer ${match[2]}`, 'X-PROJECT-ID': match[1], 'Content-Type': 'application/json' };
}

function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}

export class JamaiProvider extends BaseProvider {
  readonly platform: Platform = 'jamai';
  readonly name = 'JamAI Base';

  private body(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean): Record<string, unknown> {
    if (options?.response_format) throw Object.assign(new Error('JamAI does not support structured response formats'), { status: 422 });
    return {
      model: modelId,
      // Preserve native image/audio blocks and tool history, but never replay
      // router-only reasoning, signatures, partial/prefill or routing fields.
      messages: messages.map(({ role, content, name, tool_calls, tool_call_id }) => ({
        role, content: Array.isArray(content) ? content.map(part => typeof part === 'string' ? { type: 'text', text: part } : part) : content,
        ...(name ? { name } : {}), ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}),
      })),
      stream,
      max_tokens: resolveMaxTokens(this.platform, options?.max_tokens, options?.contextBudget),
      temperature: options?.temperature, top_p: options?.top_p,
      stop: typeof options?.stop === 'string' ? [options.stop] : options?.stop,
      presence_penalty: options?.presence_penalty, frequency_penalty: options?.frequency_penalty,
      logit_bias: options?.logit_bias, reasoning_effort: options?.reasoning_effort,
      tools: options?.tools, tool_choice: options?.tool_choice,
    };
  }

  private record(res: Response, endpoint: string, context?: QuotaObservationContext, modelId?: string): void {
    recordQuotaObservationsFromResponse(res, { ...context, platform: this.platform, endpoint, modelId });
  }

  async validateKey(credential: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    let headers: Record<string, string>;
    try { headers = jamaiHeaders(credential); } catch { return { valid: false, error: 'JamAI requires both a project ID (proj_…) and a PAT (jamai_pat_…)' }; }
    const res = await this.fetchWithTimeout(`${JAMAI_BASE_URL}/models`, { headers, redirect: 'error' },
      providerTimeoutMs(this.platform, 30_000), { timeoutBounds: 'request' });
    this.record(res, 'models', quotaContext);
    if (res.headers.get('cf-mitigated') === 'challenge') throw providerHttpError(res, 'JamAI key validation was blocked; credentials were not checked');
    if ([401, 403].includes(res.status)) return { valid: false, error: 'JamAI rejected the PAT or its access to this project' };
    if (!res.ok) throw providerHttpError(res, 'JamAI key validation is temporarily inconclusive');
    const roster = await res.json() as { data?: unknown };
    if (!Array.isArray(roster.data) || !roster.data.every(row => typeof row?.id === 'string')) throw upstreamError('returned an invalid model roster');
    return true;
  }

  private async request(credential: string, messages: ChatMessage[], modelId: string,
    options: CompletionOptions | undefined, stream: boolean, quotaContext?: QuotaObservationContext): Promise<Response> {
    const res = await this.fetchWithTimeout(`${JAMAI_BASE_URL}/chat/completions`, {
      method: 'POST', headers: jamaiHeaders(credential), redirect: 'error',
      body: JSON.stringify(this.body(messages, modelId, options, stream)),
    }, options?.timeoutMs ?? providerTimeoutMs(this.platform, 60_000),
    { signal: options?.signal, timeoutBounds: stream ? 'headers' : 'request' });
    this.record(res, 'chat/completions', quotaContext, modelId);
    // JamAI errors can echo request_headers, including credentials. Never
    // propagate its error body into router logs, API responses or UI notices.
    if (!res.ok) throw providerHttpError(res, `JamAI API error (HTTP ${res.status})`);
    return res;
  }

  async chatCompletion(credential: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const res = await this.request(credential, messages, modelId, options, false, quotaContext);
    const data = await res.json() as ChatCompletionResponse;
    checkModel(modelId, data?.model);
    if (!data.choices?.length) throw upstreamError('returned no completion choices');
    for (const choice of data.choices) {
      const message = choice.message;
      if (!message || !choice.finish_reason ||
        !(typeof message.content === 'string' && message.content.length || message.tool_calls?.length || message.reasoning_content)) {
        throw upstreamError('returned an invalid or empty completion');
      }
    }
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(credential: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.request(credential, messages, modelId, options, true, quotaContext);
    let finished = false;
    for await (const chunk of this.readSseStream(res, { firstByteTimeoutMs: options?.timeoutMs ?? providerTimeoutMs(this.platform, 60_000) })) {
      checkModel(modelId, chunk.model);
      if (!Array.isArray(chunk.choices)) throw upstreamError('returned an invalid stream chunk');
      for (const choice of chunk.choices) {
        if (!choice.delta) throw upstreamError('returned a stream chunk without delta');
        if (choice.finish_reason) finished = true;
      }
      if (!chunk.choices.length && !options?.stream_options?.include_usage) continue;
      yield chunk;
    }
    if (!finished) throw upstreamError('stream ended without a completion finish reason');
  }
}
