import { createHash, randomBytes } from 'node:crypto';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { recordQuotaObservationsFromResponse } from '../services/provider-quota.js';
import { contentToString } from '../lib/content.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { parseCredential as parseAntigravityCredential, isExpired as isAntigravityExpired, refreshCredential as refreshAntigravityCredential, type AntigravityCredential as Credential } from '../lib/antigravity-auth.js';

/** Cloud Code Assist endpoint candidates, production first. */
export const ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];

export interface AntigravityPublicModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: Array<'text' | 'image'>;
}

export const PUBLIC_MODELS: AntigravityPublicModel[] = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', reasoning: true, contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'] },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', reasoning: true, contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'] },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', reasoning: true, contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'] },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', reasoning: true, contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'] },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', reasoning: true, contextWindow: 1048576, maxTokens: 65535, input: ['text', 'image'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'] },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'] },
  { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', reasoning: true, contextWindow: 131072, maxTokens: 32768, input: ['text'] },
];

export const RUNTIME_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'gemini-3.8-flash-low': 65536,
  'gemini-3.8-flash-medium': 65536,
  'gemini-3.8-flash-high': 65536,
  'gemini-3.7-flash-low': 65536,
  'gemini-3.7-flash-medium': 65536,
  'gemini-3.7-flash-high': 65536,
  'gemini-3.6-flash-low': 65536,
  'gemini-3.6-flash-medium': 65536,
  'gemini-3.6-flash-high': 65536,
  'gemini-3.5-flash-extra-low': 65536,
  'gemini-3.5-flash-low': 65536,
  'gemini-3-flash-agent': 65536,
  'gemini-3.1-pro-low': 65535,
  'gemini-pro-agent': 65535,
  'claude-sonnet-4-6': 64000,
  'claude-opus-4-6-thinking': 64000,
  'gpt-oss-120b-medium': 32768,
};

export function getMaxOutputTokens(modelId: string, runtimeModel?: string): number {
  if (runtimeModel && RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] as number;
  }
  if (RUNTIME_MAX_OUTPUT_TOKENS[modelId] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[modelId] as number;
  }
  if (runtimeModel) {
    if (runtimeModel.startsWith('claude-')) return 64000;
    if (runtimeModel.startsWith('gpt-oss-')) return 32768;
    if (runtimeModel.startsWith('gemini-3.1-pro') || runtimeModel === 'gemini-pro-agent') return 65535;
    if (runtimeModel.startsWith('gemini-')) return 65536;
  }
  if (modelId.startsWith('claude-')) return 64000;
  if (modelId.startsWith('gpt-oss-')) return 32768;
  return 65536;
}

/** Public model id + thinking effort → Antigravity runtime model id. */
export function getRuntimeModelId(modelId: string, effort: string | undefined): string {
  const e = effort ?? 'off';
  switch (modelId) {
    case 'gemini-3.8-flash':
    case 'gemini-3.7-flash':
    case 'gemini-3.6-flash':
      if (e === 'low' || e === 'minimal' || e === 'none' || e === 'off') return `${modelId}-low`;
      if (e === 'medium') return `${modelId}-medium`;
      return `${modelId}-high`;
    case 'gemini-3.5-flash':
      if (e === 'low' || e === 'minimal' || e === 'none' || e === 'off') return 'gemini-3.5-flash-extra-low';
      if (e === 'medium') return 'gemini-3.5-flash-low';
      return 'gemini-3-flash-agent';
    case 'gemini-3.1-pro':
      if (e === 'low' || e === 'minimal' || e === 'none' || e === 'off') return 'gemini-3.1-pro-low';
      return 'gemini-pro-agent';
    case 'claude-sonnet-4-6':
      return 'claude-sonnet-4-6';
    case 'claude-opus-4-6':
      return 'claude-opus-4-6-thinking';
    case 'gpt-oss-120b':
      return 'gpt-oss-120b-medium';
    default:
      return modelId;
  }
}

/** Cross-generation fallback when a runtime id 404s. */
export function getFallbackRuntimeModel(runtimeModel: string, effort?: string): string | undefined {
  if (runtimeModel.startsWith('gemini-3.8-flash-')) {
    return runtimeModel.replace('gemini-3.8-flash-', 'gemini-3.7-flash-');
  }
  if (runtimeModel === 'gemini-3.8-flash') return getRuntimeModelId('gemini-3.7-flash', effort);
  if (runtimeModel === 'gemini-3.7-flash-tiered') return getRuntimeModelId('gemini-3.6-flash', effort);
  if (runtimeModel.startsWith('gemini-3.7-flash-')) {
    return runtimeModel.replace('gemini-3.7-flash-', 'gemini-3.6-flash-');
  }
  if (runtimeModel === 'gemini-3.7-flash') return getRuntimeModelId('gemini-3.6-flash', effort);
  return undefined;
}

export interface ThinkingWire {
  includeThoughts: boolean;
  thinkingBudget: number;
}

export function getThinkingConfig(modelId: string, effort: string | undefined): ThinkingWire | undefined {
  if (modelId.startsWith('claude-')) {
    if (!effort || effort === 'off') return { includeThoughts: false, thinkingBudget: 0 };
    return { includeThoughts: true, thinkingBudget: 1024 };
  }
  if (modelId.startsWith('gpt-oss-')) {
    // gpt-oss-120b requires thinking mode: budget 0 is rejected by Google with 400.
    return { includeThoughts: true, thinkingBudget: 8192 };
  }
  if (modelId.startsWith('gemini-3.5-flash') || modelId === 'gemini-3-flash-agent') {
    if (!effort || effort === 'off') return { includeThoughts: false, thinkingBudget: 0 };
    const thinkingBudget = effort === 'high' || effort === 'xhigh' ? 10000 : effort === 'medium' ? 4000 : 1000;
    return { includeThoughts: true, thinkingBudget };
  }
  if (modelId.startsWith('gemini-3.1-pro') || modelId === 'gemini-pro-agent') {
    // gemini-3.1-pro requires thinking mode: budget 0 is rejected by Google with 400.
    return { includeThoughts: true, thinkingBudget: effort === 'high' || effort === 'xhigh' ? 10001 : 1001 };
  }
  if (modelId.startsWith('gemini-')) {
    if (!effort || effort === 'off') return { includeThoughts: false, thinkingBudget: 0 };
    const thinkingBudget = effort === 'high' || effort === 'xhigh' ? -1 : effort === 'medium' ? 4000 : 1000;
    return { includeThoughts: true, thinkingBudget };
  }
  return undefined;
}

interface GeminiPart {
  text?: string;
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** Chat history → Gemini contents (assistant→model, tool→functionResponse). */
export function buildGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.name ?? 'unknown', response: contentToString(m.content) } }],
      });
      continue;
    }
    const text = contentToString(m.content);
    if (text || !(m.tool_calls?.length)) {
      out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
    }
    for (const call of m.tool_calls ?? []) {
      out.push({
        role: 'model',
        parts: [{ text: `[function call: ${call.function.name}]` }],
      });
    }
  }
  return out;
}

/** Full Gemini request body (contents + systemInstruction + generationConfig). */
export function buildGeminiBody(
  messages: ChatMessage[],
  modelId: string,
  runtimeModel: string,
  options?: CompletionOptions,
): Record<string, unknown> {
  const contents = buildGeminiContents(messages);
  const systems = messages.filter(m => m.role === 'system').map(m => contentToString(m.content)).filter(Boolean);
  const body: Record<string, unknown> = {
    contents,
    systemInstruction: { role: 'user', parts: [{ text: systems.join('\n\n') || 'You are a helpful assistant.' }] },
  };
  const generationConfig: Record<string, unknown> = {};
  if (options?.temperature !== undefined) generationConfig['temperature'] = options.temperature;
  const maxAllowed = getMaxOutputTokens(modelId, runtimeModel);
  generationConfig['maxOutputTokens'] = options?.max_tokens !== undefined
    ? Math.min(options.max_tokens, maxAllowed)
    : Math.min(maxAllowed, 65536);
  const thinking = getThinkingConfig(runtimeModel, options?.reasoning_effort ?? 'off');
  if (thinking) generationConfig['thinkingConfig'] = thinking;
  if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;
  const tools = toAntigravityTools(options?.tools);
  if (tools?.length) body['tools'] = tools;
  if (options?.tool_choice && options.tool_choice !== 'auto' && tools?.some(t => 'functionDeclarations' in t)) {
    const choice = options.tool_choice as ChatToolChoice;
    body['toolConfig'] = {
      functionCallingConfig: { mode: typeof choice === 'string' ? choice.toUpperCase() : 'ANY' },
    };
  }
  return body;
}

const GROUNDING_TOOL_NAMES = new Set(['google_search', 'googlesearch', 'google_search_retrieval']);

export function toAntigravityTools(tools?: ChatToolDefinition[]): Array<Record<string, unknown>> | undefined {
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
      parameters: t.function.parameters,
    });
  }
  const out: Array<Record<string, unknown>> = [];
  if (grounding) out.push({ google_search: {} });
  if (functionDeclarations.length > 0) out.push({ functionDeclarations });
  return out.length > 0 ? out : undefined;
}

/** Quota-wall classification: hard per-account walls carry a reset hint and
 *  must fail over to the next account/key instead of burning retries on the
 *  same credential; transient throttling stays retryable. */
export function isHardQuotaWall(status: number | undefined, text: string): boolean {
  if (status !== 429) return false;
  if (/Individual quota reached/i.test(text)) return true;
  if (/Resets? in /i.test(text)) return true;
  if (/rate.?limit/i.test(text)) return false;
  return /quota exceeded|exceeded your|daily limit/i.test(text);
}

export interface AntigravityEnvelope {
  sessionId: string;
  requestId: string;
  trajectoryId: string;
  conversationId: string;
  labels: Record<string, string>;
}

function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map(x => (x as number).toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Agent envelope: step = content-block count, last_step 0-based, requestId
 *  advances per completed assistant turn in the loop; labels wire non-gemini/claude. */
export function buildEnvelope(
  runtimeModel: string,
  contentsLength: number,
  assistantTurns: number,
  sessionId?: string,
): AntigravityEnvelope {
  const isClaude = runtimeModel.startsWith('claude-');
  const isNonGemini = isClaude || runtimeModel.startsWith('gpt-oss-') || !runtimeModel.startsWith('gemini-');
  const step = Math.max(1, contentsLength);
  const conversationId = uuid();
  const trajectoryId = uuid();
  const randBytes = randomBytes(8);
  const sid = sessionId ?? String(new DataView(randBytes.buffer, randBytes.byteOffset, 8).getBigInt64(0, true));
  const claudeLabel = isClaude ? 'true' : 'false';
  const nonGeminiLabel = isNonGemini ? 'true' : 'false';
  return {
    sessionId: sid,
    trajectoryId,
    conversationId,
    requestId: `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`,
    labels: {
      step: String(step),
      last_step_index: String(Math.max(0, contentsLength - 1)),
      request_id: `${trajectoryId}-${assistantTurns}`,
      trajectory_id: trajectoryId,
      used_claude: claudeLabel,
      used_claude_conservative: claudeLabel,
      used_non_gemini_model: nonGeminiLabel,
    },
  };
}

/** Full generate request: envelope + project + runtime model id. */
export function buildGenerateBody(
  messages: ChatMessage[],
  modelId: string,
  runtimeModel: string,
  projectId: string,
  options?: CompletionOptions,
  sessionId?: string,
): Record<string, unknown> {
  const gemini = buildGeminiBody(messages, modelId, runtimeModel, options);
  const assistantTurns = messages.filter(m => m.role === 'assistant').length;
  const contents = gemini['contents'];
  const envelope = buildEnvelope(runtimeModel, Array.isArray(contents) ? contents.length : 1, assistantTurns, sessionId);
  return {
    project: projectId,
    model: runtimeModel,
    request: { ...gemini, sessionId: envelope.sessionId, labels: envelope.labels },
    requestType: 'Agent',
    userAgent: 'antigravity',
    requestId: envelope.requestId,
  };
}

/** Pull a project id out of listCloudAICompanionProjects payloads (shape
 *  varies: direct fields, nested {id}, or arrays under several keys). */
export function extractProjectId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const rec = data as Record<string, unknown>;
  const direct = rec['antigravityProjectId'] ?? rec['projectId'] ?? rec['backendProjectId']
    ?? rec['userDefinedCloudaicompanionProject'] ?? rec['cloudaicompanionProject'] ?? rec['project'];
  if (typeof direct === 'string' && direct) return direct;
  if (direct && typeof direct === 'object') {
    const nested = (direct as Record<string, unknown>)['id'];
    if (typeof nested === 'string' && nested) return nested;
  }
  for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
    const value = rec[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item) return item;
        const nested = extractProjectId(item);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

/** Stable UUID-shaped project id from a seed (email preferred, matches pi-antigravity). */
export function stableProjectId(seed: string): string {
  const bytes = createHash('sha1').update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function defaultProjectId(seed = 'antigravity-default'): string {
  return process.env.ANTIGRAVITY_PROJECT_ID?.trim() || stableProjectId(seed);
}
/** User-Agent matching the Antigravity CLI wire fingerprint. */
const ANTIGRAVITY_UA = 'antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)';

export class AntigravityProvider extends BaseProvider {
  readonly platform: Platform = 'antigravity';
  readonly name = 'Google Antigravity';
  private readonly timeoutMs: number;
  /** Discovered runtime ids from fetchAvailableModels (static fallback below). */
  private discoveredRuntimes = new Set<string>();

  constructor(timeoutMs?: number) {
    super();
    this.timeoutMs = providerTimeoutMs('antigravity', timeoutMs ?? 60_000);
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': ANTIGRAVITY_UA };
  }

  private record(res: Response, endpoint: string, quotaContext: QuotaObservationContext | undefined, modelId: string): void {
    recordQuotaObservationsFromResponse(res, { platform: this.platform, keyId: quotaContext?.keyId, providerAccountId: quotaContext?.providerAccountId, modelId, quotaPoolKey: quotaContext?.quotaPoolKey, endpoint });
  }

  private async credential(apiKey: string): Promise<Credential> {
    const cred = parseAntigravityCredential(apiKey);
    if (isAntigravityExpired(cred)) return refreshAntigravityCredential(cred);
    return cred;
  }

  async discoverProject(token: string, seed = 'antigravity-default'): Promise<string> {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await this.fetchWithTimeout(`${endpoint}/v1internal:loadCodeAssist`, {
          method: 'POST',
          headers: this.headers(token),
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
        }, 8000, { timeoutBounds: 'request' });
        if (res.ok) {
          const data = (await res.json()) as unknown;
          const id = extractProjectId(data);
          if (id) return id;
        }
      } catch { /* try list */ }

      try {
        const res = await this.fetchWithTimeout(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
          method: 'POST',
          headers: this.headers(token),
          body: JSON.stringify({}),
        }, 8000, { timeoutBounds: 'request' });
        if (res.ok) {
          const data = (await res.json()) as unknown;
          const id = extractProjectId(data);
          if (id) return id;
        }
      } catch { /* next endpoint */ }
    }
    return defaultProjectId(seed);
  }

  private async projectId(token: string, email?: string): Promise<string> {
    return this.discoverProject(token, email || 'antigravity-default');
  }
  /** Merge fetchAvailableModels payloads; static table stays the fallback. */
  async refreshCatalog(token: string, projectId: string): Promise<void> {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await this.fetchWithTimeout(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST', headers: this.headers(token), body: JSON.stringify({ project: projectId }),
        }, 8000, { timeoutBounds: 'request' });
        if (!res.ok) continue;
        const data = (await res.json()) as { models?: Record<string, unknown> };
        if (data.models) {
          for (const id of Object.keys(data.models)) {
            if (/^(gemini-|claude-|gpt-oss-)/i.test(id) && !id.startsWith('MODEL_')) this.discoveredRuntimes.add(id);
          }
          return;
        }
      } catch { /* next endpoint */ }
    }
  }

  private resolveRuntime(modelId: string, effort: string): { runtime: string; fallback?: string } {
    const runtime = getRuntimeModelId(modelId, effort);
    return { runtime, fallback: getFallbackRuntimeModel(runtime, effort) };
  }

  private async generate(
    apiKey: string, messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined,
    quotaContext: QuotaObservationContext | undefined,
  ): Promise<Response> {
    const cred = await this.credential(apiKey);
    const project = cred.projectId ?? await this.projectId(cred.token, cred.email);
    const effort = options?.reasoning_effort ?? 'off';
    const { runtime, fallback } = this.resolveRuntime(modelId, effort);
    const body = JSON.stringify(buildGenerateBody(messages, modelId, runtime, project, options));
    const runtimes = fallback ? [runtime, fallback] : [runtime];
    let lastText = '';
    let lastStatus = 0;
    for (const rt of runtimes) {
      void rt;
      for (const endpoint of ENDPOINTS) {
        const res = await this.fetchWithTimeout(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
          method: 'POST', headers: this.headers(cred.token), body,
        }, options?.timeoutMs ?? this.timeoutMs, { signal: options?.signal });
        this.record(res, 'streamGenerateContent', quotaContext, modelId);
        if (res.ok) return res;
        lastStatus = res.status;
        lastText = await res.text().catch(() => '');
        if (isHardQuotaWall(res.status, lastText)) break;
        if (![403, 404, 429, 500, 502, 503, 504].includes(res.status)) break;
      }
    }
    throw providerHttpError(new Response(null, { status: lastStatus || 502 }), `Google Antigravity API error ${lastStatus}: ${lastText.slice(0, 300)}`);
  }

  async chatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const res = await this.generate(apiKey, messages, modelId, options, quotaContext);
    const { content, finish } = await this.accumulateAntigravityStream(res, options, modelId);
    return {
      id: `chatcmpl-agy-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelId,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  /** Antigravity SSE frames carry candidates[].content.parts[].text (Gemini
   *  shape), not OpenAI choices[].delta — translate frame by frame. */
  private async *translateAntigravityStream(res: Response, options: CompletionOptions | undefined, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    let sawFinish = false;
    const base = { id: `chatcmpl-agy-${Date.now()}`, object: 'chat.completion.chunk' as const, created: Math.floor(Date.now() / 1000), model: modelId };
    yield { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;
          let frame: Record<string, unknown>;
          try { frame = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          const resp = (frame['response'] && typeof frame['response'] === 'object') ? frame['response'] as Record<string, unknown> : frame;
          const candidates = (Array.isArray(resp['candidates']) ? resp['candidates'] : []) as Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
          for (const cand of candidates) {
            const text = (cand.content?.parts ?? []).map(p => p.text ?? '').join('');
            if (text) yield { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
            if (cand.finishReason) {
              sawFinish = true;
              yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: cand.finishReason === 'MAX_TOKENS' ? 'length' : 'stop' }] };
            }
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* upstream already gone */ });
    }
    if (!sawFinish) yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  }

  private async accumulateAntigravityStream(res: Response, options: CompletionOptions | undefined, modelId: string): Promise<{ content: string; finish: 'stop' | 'length' }> {
    let content = '';
    let finish: 'stop' | 'length' = 'stop';
    for await (const chunk of this.translateAntigravityStream(res, options, modelId)) {
      const choice = chunk.choices?.[0];
      if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
      if (choice?.finish_reason === 'length') finish = 'length';
    }
    return { content, finish };
  }

  async *streamChatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.generate(apiKey, messages, modelId, options, quotaContext);
    yield* this.translateAntigravityStream(res, options, modelId);
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    let cred;
    try { cred = parseAntigravityCredential(apiKey); } catch { return { valid: false, error: 'Google Antigravity credential is not a login blob — complete Google login first' }; }
    try {
      const project = cred.projectId ?? await this.projectId(cred.token, cred.email);
      void quotaContext; void project;
      return true;
    } catch (err) {
      return { valid: false, error: `Google Antigravity validation failed: ${(err as Error).message}` };
    }
  }
}
