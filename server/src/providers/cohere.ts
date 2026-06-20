import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { flattenMessageContent } from '../lib/content.js';
import { stripSchemaKeys } from '../lib/tool-args.js';

const API_BASE = 'https://api.cohere.ai/compatibility/v1';

// Cohere's compat-endpoint tool-schema validator rejects a couple of JSON-Schema
// keywords that strict clients (opencode, continue.dev) send by default, 400-ing
// the whole request and silently killing tool calls. They carry no meaning for
// the provider, so strip them before sending. Mirrors google.ts's sanitizeForGemini
// but scoped to the keys Cohere actually rejects, since its endpoint is otherwise
// OpenAI-compatible. (Multi-fork-validated: SeanPedersen, andersmmg, chirag127.)
const COHERE_UNSUPPORTED_SCHEMA_KEYS = new Set(['additionalProperties', '$schema']);

function sanitizeCohereTools(tools?: ChatToolDefinition[]): ChatToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return tools;
  return tools.map((t) =>
    t.function?.parameters
      ? { ...t, function: { ...t.function, parameters: stripSchemaKeys(t.function.parameters, COHERE_UNSUPPORTED_SCHEMA_KEYS) } }
      : t,
  );
}

export class CohereProvider extends BaseProvider {
  readonly platform = 'cohere' as const;
  readonly name = 'Cohere';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: flattenMessageContent(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: sanitizeCohereTools(options?.tools),
      tool_choice: options?.tool_choice,
    };

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cohere API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: 'cohere', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: flattenMessageContent(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: sanitizeCohereTools(options?.tools),
      tool_choice: options?.tool_choice,
      stream: true,
    };

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cohere API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    yield* this.readSseStream(res);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed 401/403 disables a key.
    const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }
}
