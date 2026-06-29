import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { contentToString } from '../lib/content.js';
import { proxyFetch } from '../lib/proxy.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Gemini 3 REQUIRES the `thoughtSignature` that accompanied a function call to
// be echoed back whenever that call appears in conversation history, or it
// rejects the request with 400 "Function call is missing a thought_sig". But
// OpenAI-format clients (the API surface we expose) have no field to carry a
// provider-specific signature, so it's dropped on the round-trip and every
// multi-turn tool conversation through Gemini fails. To bridge this without a
// schema change, cache each signature we emit keyed by tool-call id and
// re-attach it when the same call comes back without one. Strictly additive: a
// cache miss yields exactly the previous behavior (the request may 400 and fail
// over, as before). Bounded with a TTL so it can't grow unbounded.
const THOUGHT_SIG_TTL_MS = 30 * 60 * 1000; // 30 min — longer than any single tool loop
const THOUGHT_SIG_MAX = 5000;
const thoughtSigCache = new Map<string, { sig: string; exp: number }>();

function rememberThoughtSig(callId: string | undefined, sig: string | undefined): void {
  if (!callId || !sig) return;
  // Cheap eviction: when full, drop the oldest insertion (Map preserves order).
  if (thoughtSigCache.size >= THOUGHT_SIG_MAX) {
    const oldest = thoughtSigCache.keys().next().value;
    if (oldest !== undefined) thoughtSigCache.delete(oldest);
  }
  thoughtSigCache.set(callId, { sig, exp: Date.now() + THOUGHT_SIG_TTL_MS });
}

function recallThoughtSig(callId: string | undefined): string | undefined {
  if (!callId) return undefined;
  const hit = thoughtSigCache.get(callId);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    thoughtSigCache.delete(callId);
    return undefined;
  }
  return hit.sig;
}

interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { value: raw };
  }
}

function normalizeGeminiArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  return JSON.stringify(args ?? {});
}

function toGeminiFinishReason(finishReason?: string): string {
  const r = (finishReason ?? '').toUpperCase();
  if (!r) return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (r === 'SAFETY' || r === 'RECITATION' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT' || r === 'SPII') {
    return 'content_filter';
  }
  return 'stop';
}

// Google Gemini accepts only a subset of JSON Schema (~OpenAPI 3.0).
// Strip fields that opencode / other strict-JSON-Schema clients send but
// Google rejects with 400 "Unknown name '<field>'".
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment',
  'definitions',
  'exclusiveMinimum', 'exclusiveMaximum',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'if', 'then', 'else',
  'contentEncoding', 'contentMediaType', 'contentSchema',
  'dependentRequired', 'dependentSchemas', 'dependencies',
  'additionalProperties',
  'examples', 'const', 'readOnly', 'writeOnly',
  'uniqueItems',
  'not', 'allOf', 'oneOf',
  'prefixItems',
  'contains', 'minContains', 'maxContains',
  'propertyNames',
  'multipleOf',
  'deprecated',
]);

const VENDOR_EXTENSION_SCHEMA_KEY = /^x-/i;

export function sanitizeForGemini(schema: unknown): unknown {
  return sanitizeForGeminiSchema(schema, false);
}

function sanitizeForGeminiSchema(schema: unknown, insidePropertiesMap: boolean): unknown {
  if (Array.isArray(schema)) {
    return schema.map(s => sanitizeForGeminiSchema(s, false));
  }
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (insidePropertiesMap) {
        out[k] = sanitizeForGeminiSchema(v, false);
        continue;
      }
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(k) || VENDOR_EXTENSION_SCHEMA_KEY.test(k)) continue;
      out[k] = sanitizeForGeminiSchema(v, k === 'properties');
    }
    return out;
  }
  return schema;
}

// OpenAI clients can't express Gemini's native Google Search grounding, so we
// treat a tool named `google_search` (a few spellings) as the signal to enable
// it. It maps to Gemini's `{ google_search: {} }` tool rather than a function
// declaration, and can ride alongside real function tools in the same array. (#59)
const GROUNDING_TOOL_NAMES = new Set(['google_search', 'googlesearch', 'google_search_retrieval']);

function toGeminiTools(tools?: ChatToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;

  const functionDeclarations: Array<Record<string, unknown>> = [];
  let grounding = false;
  for (const t of tools) {
    if (GROUNDING_TOOL_NAMES.has(t.function.name.toLowerCase())) {
      grounding = true;
      continue;
    }
    functionDeclarations.push({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeForGemini(t.function.parameters),
    });
  }

  const out: Array<Record<string, unknown>> = [];
  if (grounding) out.push({ google_search: {} });
  if (functionDeclarations.length > 0) out.push({ functionDeclarations });
  return out.length > 0 ? out : undefined;
}

function hasFunctionDeclarations(tools?: Array<Record<string, unknown>>): boolean {
  return tools?.some(t => 'functionDeclarations' in t) ?? false;
}

function toGeminiToolConfig(toolChoice?: ChatToolChoice): { functionCallingConfig: Record<string, unknown> } | undefined {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    const mode =
      toolChoice === 'none'
        ? 'NONE'
        : toolChoice === 'required'
          ? 'ANY'
          : 'AUTO';
    return { functionCallingConfig: { mode } };
  }

  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [toolChoice.function.name],
    },
  };
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB cap on fetched/inlined images

// Pull the URL out of an OpenAI image content block. Accepts both the object
// form `{ image_url: { url } }` and the shorthand `{ image_url: '...' }`.
function extractImageUrl(block: unknown): string | undefined {
  const iu = (block as { image_url?: unknown })?.image_url;
  if (typeof iu === 'string') return iu;
  if (iu && typeof (iu as { url?: unknown }).url === 'string') return (iu as { url: string }).url;
  return undefined;
}

// Convert an image URL to a Gemini inlineData part. Handles base64 `data:` URLs
// directly; for `http(s)` URLs we fetch and inline because the Gemini API does
// not fetch external URLs itself. Fetching a user-supplied URL is a minor SSRF
// surface, acceptable for a single-user self-hosted proxy; we still restrict to
// http/https and cap the size. Returns null (part skipped) on any failure.
async function imageUrlToInlineData(url: string): Promise<{ mimeType: string; data: string } | null> {
  const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (dataMatch) {
    const mimeType = dataMatch[1] || 'application/octet-stream';
    const isBase64 = Boolean(dataMatch[2]);
    const payload = dataMatch[3] ?? '';
    const data = isBase64
      ? payload
      : Buffer.from(decodeURIComponent(payload)).toString('base64');
    return { mimeType, data };
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await proxyFetch(url, undefined, 'google');
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
      const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
      return { mimeType, data: buf.toString('base64') };
    } catch {
      return null;
    }
  }
  return null;
}

// Build Gemini parts for a user message: joined text first, then any images as
// inlineData. Non-array content (string/null) collapses to a single text part.
async function userContentToParts(content: ChatMessage['content']): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [];
  const text = contentToString(content);
  if (text.length > 0) parts.push({ text });

  if (Array.isArray(content)) {
    for (const block of content) {
      const type = (block as { type?: string })?.type;
      if (type !== 'image_url' && type !== 'image') continue;
      const url = extractImageUrl(block);
      if (!url) continue;
      const inlineData = await imageUrlToInlineData(url);
      if (inlineData) parts.push({ inlineData });
    }
  }

  // Gemini rejects empty `parts`; keep at least one (possibly empty) text part.
  if (parts.length === 0) parts.push({ text: '' });
  return parts;
}

// Translate OpenAI messages to Gemini format. Content may arrive as a string,
// null, or the OpenAI multimodal array envelope. System/assistant/tool messages
// flatten to text; user messages additionally carry images as inlineData parts.
async function toGeminiContents(messages: ChatMessage[]) {
  const systemMessages = messages
    .filter(m => m.role === 'system')
    .map(m => contentToString(m.content))
    .filter(s => s.length > 0);

  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      toolNameByCallId.set(tc.id, tc.function.name);
    }
  }

  const contents = (await Promise.all(messages
    .filter(m => m.role !== 'system')
    .map(async (m): Promise<{ role: 'user' | 'model'; parts: GeminiPart[] } | null> => {
      if (m.role === 'assistant') {
        const parts: GeminiPart[] = [];

        const assistantText = contentToString(m.content);
        if (assistantText.length > 0) {
          parts.push({ text: assistantText });
        }

        for (const call of m.tool_calls ?? []) {
          // Prefer a signature the client preserved; otherwise recover the one
          // we cached when this call was first produced (OpenAI-format clients
          // drop the field, so this is the common path for Gemini multi-turn).
          const sig = call.thought_signature ?? recallThoughtSig(call.id);
          parts.push({
            thoughtSignature: sig,
            functionCall: {
              id: call.id,
              name: call.function.name,
              args: safeParseObject(call.function.arguments),
            },
          });
        }

        if (parts.length === 0) return null;
        return {
          role: 'model',
          parts,
        };
      }

      if (m.role === 'tool') {
        const toolCallId = m.tool_call_id;
        if (!toolCallId) return null;

        const toolName = m.name ?? toolNameByCallId.get(toolCallId) ?? 'tool';
        const response = safeParseObject(contentToString(m.content));

        return {
          role: 'user',
          parts: [{
            functionResponse: {
              id: toolCallId,
              name: toolName,
              response,
            },
          }],
        };
      }

      return {
        role: 'user',
        parts: await userContentToParts(m.content),
      };
    })))
    .filter((entry): entry is { role: 'user' | 'model'; parts: GeminiPart[] } => entry !== null);

  return {
    contents,
    systemInstruction: systemMessages.length > 0
      ? { parts: [{ text: systemMessages.join('\n\n') }] }
      : undefined,
  };
}

function extractToolCalls(parts: GeminiPart[] | undefined): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  if (!parts) return calls;

  let fallbackIndex = 0;
  for (const part of parts) {
    if (!part.functionCall?.name) continue;

    const id = part.functionCall.id ?? `call_${Date.now()}_${fallbackIndex++}`;
    // Cache the signature keyed by the id we hand the client, so when the client
    // echoes this call back (without the signature, as OpenAI format requires)
    // we can re-attach it and Gemini accepts the history.
    rememberThoughtSig(id, part.thoughtSignature);
    calls.push({
      id,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: normalizeGeminiArgs(part.functionCall.args),
      },
      thought_signature: part.thoughtSignature,
    });
  }

  return calls;
}

function extractText(parts: GeminiPart[] | undefined): string | null {
  if (!parts) return null;
  const text = parts
    .map(p => p.text ?? '')
    .join('');
  return text.length > 0 ? text : null;
}

function toGeminiStopSequences(stop: CompletionOptions['stop']): string[] | undefined {
  if (!stop) return undefined;
  return Array.isArray(stop) ? stop : [stop];
}

export class GoogleProvider extends BaseProvider {
  readonly platform = 'google' as const;
  readonly name = 'Google AI Studio';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const { contents, systemInstruction } = await toGeminiContents(messages);

    const tools = toGeminiTools(options?.tools);
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
        stopSequences: toGeminiStopSequences(options?.stop),
      },
      tools,
      // functionCallingConfig is only valid when real function tools are present;
      // a grounding-only request (just google_search) must omit it. (#59)
      toolConfig: hasFunctionDeclarations(tools) ? toGeminiToolConfig(options?.tool_choice) : undefined,
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      throw providerHttpError(res, `Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    const toolCalls = extractToolCalls(parts);
    const text = extractText(parts);

    const usage: TokenUsage = {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    };

    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : toGeminiFinishReason(candidate?.finishReason),
      }],
      usage,
      _routed_via: { platform: 'google', model: modelId },
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { contents, systemInstruction } = await toGeminiContents(messages);

    const tools = toGeminiTools(options?.tools);
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
        stopSequences: toGeminiStopSequences(options?.stop),
      },
      tools,
      toolConfig: hasFunctionDeclarations(tools) ? toGeminiToolConfig(options?.tool_choice) : undefined,
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${API_BASE}/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      throw providerHttpError(res, `Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const id = this.makeId();
    let buffer = '';
    let emittedFinish = false;
    let sawToolCalls = false;

    const seenToolCallKeys = new Set<string>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const raw = trimmed.slice(6);
        if (raw === '[DONE]') {
          if (!emittedFinish) {
            emittedFinish = true;
            yield {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
              }],
            };
          }
          return;
        }

        // Skip malformed SSE frames instead of aborting the whole stream.
        // Matches the defensive parse in openai-compat / cohere / cloudflare:
        // a single corrupt chunk shouldn't take down the rest of the response.
        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(raw) as GeminiResponse;
        } catch {
          continue;
        }
        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        const text = extractText(parts);
        const toolCalls = extractToolCalls(parts).filter(call => {
          const key = `${call.id}:${call.function.name}:${call.function.arguments}`;
          if (seenToolCallKeys.has(key)) return false;
          seenToolCallKeys.add(key);
          return true;
        });

        if ((text && text.length > 0) || toolCalls.length > 0) {
          sawToolCalls = sawToolCalls || toolCalls.length > 0;
          yield {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                ...(text ? { content: text } : {}),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: null,
            }],
          };
        }

        if (candidate?.finishReason && !emittedFinish) {
          emittedFinish = true;
          yield {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: sawToolCalls ? 'tool_calls' : toGeminiFinishReason(candidate.finishReason),
            }],
          };
          return;
        }
      }
    }

    if (!emittedFinish) {
      yield {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
        }],
      };
    }
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable.
    const res = await this.fetchWithTimeout(
      `${API_BASE}/models?key=${apiKey}`,
      { method: 'GET' },
      10000,
    );
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId: quotaContext?.modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'models',
    });
    if (res.ok) return true;

    // Google's error taxonomy is NOT the usual 401/403-means-bad-key (#268):
    //   - bad/expired key            → HTTP 400 INVALID_ARGUMENT / reason API_KEY_INVALID
    //   - API not enabled on project → HTTP 403 PERMISSION_DENIED / reason SERVICE_DISABLED
    //   - IP / referrer / API-key restriction, or empty key → HTTP 403 PERMISSION_DENIED
    //   - unsupported region         → HTTP 400 FAILED_PRECONDITION ("User location is not supported")
    // The old check (`status !== 401 && status !== 403`) had this exactly
    // backwards: it marked a genuinely-bad 400 key as HEALTHY, and auto-disabled
    // a perfectly good key that merely hit a permission/region/restriction 403 on
    // the host running the proxy (the key still works for generateContent from
    // another network). So only a CONFIRMED bad credential returns false (which
    // counts toward auto-disable); every other non-2xx is inconclusive and throws
    // so health.ts records status='error' WITHOUT disabling a usable key.
    type GoogleErrorBody = { error?: { message?: unknown; status?: unknown; details?: unknown } };
    let body: GoogleErrorBody | null = null;
    try { body = (await res.json()) as GoogleErrorBody; } catch { /* non-JSON error body */ }
    const err = body?.error;
    const details = Array.isArray(err?.details) ? err!.details as Array<{ reason?: unknown }> : [];
    const reason = details.find(d => typeof d?.reason === 'string')?.reason as string | undefined;
    const message = typeof err?.message === 'string' ? err.message : '';
    const gStatus = typeof err?.status === 'string' ? err.status : undefined;

    const badCredentials =
      res.status === 401 ||
      reason === 'API_KEY_INVALID' ||
      /API key not valid|API key expired|API_KEY_INVALID/i.test(message);
    if (badCredentials) {
      console.warn(`[Google] validateKey: key rejected as invalid (HTTP ${res.status}${reason ? ` ${reason}` : ''})`);
      return false;
    }

    console.warn(
      `[Google] validateKey: inconclusive HTTP ${res.status} (${gStatus ?? 'UNKNOWN'}${reason ? `/${reason}` : ''}): ${message.slice(0, 200)} ` +
      `— treating as 'error', not auto-disabling (the key may be valid but blocked by region/permission/restriction on this host).`,
    );
    throw new Error(`Google key validation inconclusive (HTTP ${res.status}${gStatus ? ` ${gStatus}` : ''})`);
  }
}
