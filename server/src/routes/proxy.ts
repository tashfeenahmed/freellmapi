import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, ChatToolCall, ModelListRow } from '@freellmapi/shared/types.js';
import { routeRequest, resolveRoutingChain, resolveModelGroupCandidates, recordRateLimitHit, recordSuccess, hasEnabledVisionModel, hasEnabledToolsModel, hasOtherUsableKey, routingReserveTokens, type RouteResult, type ResolvedChain, type ChainRow } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit, PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_FORBIDDEN_COOLDOWN_MS, learnLimitFromError } from '../services/ratelimit.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { runImageGeneration, runSpeech, MediaError } from '../services/media.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { contentToString, messageHasImage, normalizeOutboundContent, sanitizeResponse } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import { getContextHandoffMode, recordIncomingMessages, maybeInjectContextHandoff, recordSuccessfulModel, hasPriorModel, HANDOFF_MAX_TOKENS } from '../services/context-handoff.js';
import { isFusionModel, runFusion, fusionConfigSchema, FusionError, FUSION_MODEL_ID } from '../services/fusion.js';
import { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError } from '../lib/error-classify.js';
import { logRequest } from '../lib/request-log.js';
import { parseCacheDirective, cacheActive, isCacheableTemperature, computeCacheKey, getCachedResponse, storeCachedResponse } from '../services/cache.js';
import { runFallbackLoop, newFallbackState, recordUpstreamSuccess, exhaustedRetryError } from '../lib/fallback-loop.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { inferQuotaPoolKey, type QuotaObservationContext } from '../services/provider-quota.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdToMembers } from '../services/model-groups.js';
import { buildModelListing } from '../services/model-listing.js';

export const proxyRouter = Router();

// Virtual "auto" model. Clients like Hermes require a non-empty `model` field
// on every request, but freellmapi's whole point is to pick the model itself.
// Requesting this id means "let the router decide" — identical to omitting
// `model` entirely.
const AUTO_MODEL_ID = 'auto';

function isAutoModel(modelId: string | undefined): boolean {
  if (!modelId) return true;
  const lower = modelId.toLowerCase();
  return lower === AUTO_MODEL_ID || lower.startsWith(`${AUTO_MODEL_ID}:`);
}

// Constant-time string comparison for the unified API key. Plain `===` leaks
// length and per-character timing, which a network attacker could in principle
// use to recover the key one byte at a time.
export function timingSafeStringEqual(provided: string, expected: string): boolean {
  // Use HMAC to produce fixed-length digests so timingSafeEqual always
  // receives same-length buffers regardless of input length. This eliminates
  // both the per-character timing leak and the length-branch timing leak that
  // the Buffer.alloc-on-mismatch approach had.
  const key = Buffer.alloc(32);
  const a = crypto.createHmac('sha256', key).update(provided).digest();
  const b = crypto.createHmac('sha256', key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Extract the unified API key from an incoming request. Accepts both the
// OpenAI-style `Authorization: Bearer <key>` header and the Anthropic-style
// `x-api-key` header. Clients that speak the Anthropic wire format — notably
// Claude Code routed through CC Switch (#103) — send the key in `x-api-key`
// rather than a bearer token, and were getting a spurious "Invalid API key"
// 401 before this fallback existed.
export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers['x-api-key'];
  const xApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = xApiKey?.trim();
  return trimmed || undefined;
}

function quotaContextForRoute(route: RouteResult, endpoint: string): QuotaObservationContext {
  return {
    platform: route.platform as Platform,
    keyId: route.keyId,
    modelId: route.modelId,
    quotaPoolKey: inferQuotaPoolKey(route.platform as Platform, route.modelId),
    endpoint,
    origin: 'proxy',
  };
}

export function getRequestGroupId(req: Request): string {
  const raw = req.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || crypto.randomUUID();
}

function shortRequestId(requestId: string): string {
  return requestId.replace(/-/g, '').slice(0, 6);
}

type TraceEvent = 'start' | 'next' | 'ok' | 'fail';

export function traceRouteEvent(
  scope: 'Proxy' | 'Responses',
  opts: {
    event: TraceEvent;
    requestId: string;
    attempt: number;
    platform: string;
    model: string;
    requestedModel?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
  },
) {
  const parts = [
    `[${scope}]`,
    new Date().toISOString().slice(11, 19),
    opts.event,
    shortRequestId(opts.requestId),
    `a${opts.attempt}`,
    opts.platform,
    '-',
    opts.model,
  ];
  if (opts.requestedModel) parts.push(`req=${opts.requestedModel}`);
  if (opts.latencyMs != null) parts.push(`lat=${opts.latencyMs}ms`);
  if (opts.inputTokens != null) parts.push(`in=${opts.inputTokens}`);
  if (opts.outputTokens != null) parts.push(`out=${opts.outputTokens}`);
  if (opts.error) parts.push(`err=${JSON.stringify(opts.error)}`);
  console.log(parts.join(' '));
}

// exhaustedRetryError moved to lib/fallback-loop.ts (the shared retry loop needs
// it and importing it back from a route would be a cycle). Re-exported here for
// existing importers (routes/responses.ts, proxy-retry.test.ts historically).
export { exhaustedRetryError };

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string): string {
  if (sessionIdHeader) {
    return strategyKey ? `hdr:${sessionIdHeader}::${strategyKey}` : `hdr:${sessionIdHeader}`;
  }

  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const text = contentToString(firstUser.content ?? '');
  if (!text) return '';
  const payload = strategyKey ? `${text}::${strategyKey}` : text;
  return crypto.createHash('sha1').update(payload).digest('hex');
}

export function getStickyModel(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string): number | undefined {
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages, sessionIdHeader, strategyKey);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

export function setStickyModel(messages: ChatMessage[], modelDbId: number, sessionIdHeader?: string, strategyKey?: string) {
  const key = getSessionKey(messages, sessionIdHeader, strategyKey);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }

    // Hard cap: if still over 1000 after pruning expired entries, evict oldest by lastUsed
    if (stickySessionMap.size > 1000) {
      const entries = [...stickySessionMap.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed
      );
      const toEvict = stickySessionMap.size - 1000;
      for (let i = 0; i < toEvict; i++) {
        stickySessionMap.delete(entries[i][0]);
      }
    }
  }
}

// OpenAI-compatible /models endpoint (used by Hermes for metadata) 
// shows API models which is linked by the user
proxyRouter.get('/models', (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  // By default we return the WHOLE catalog (one row per model id), each tagged
  // with whether it is currently usable, so a client can see everything and know
  // what's connected vs. disabled/keyless (#242). `?available=true` (alias
  // `?connected=true`) narrows the list to only models that can serve a request
  // right now — the previous default behavior. `available` is computed as
  // "enabled AND an enabled key can serve it"; dedup prefers an available
  // instance of a model id over a disabled/keyless one.
  // Shared catalog listing (one source of truth for the OpenAI and Anthropic
  // /v1/models endpoints — see services/model-listing.ts). `autoContextWindow`
  // is the honest ceiling for the virtual "auto" model: the largest context
  // window among models that can serve a request right now. Advertising null
  // makes OpenAI-compatible clients (opencode, Continue) fall back to their own
  // conservative default and truncate long inputs before they reach us (#282).
  const { models: allListed, autoContextWindow } = buildModelListing();

  const q = String(req.query.available ?? req.query.connected ?? '').toLowerCase();
  const onlyAvailable = q === '1' || q === 'true' || q === 'yes';
  const listed = onlyAvailable ? allListed.filter(m => m.available === 1) : allListed;

  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Auto (router picks the best available model)',
        context_window: autoContextWindow,
        // `context_length` is OpenRouter's field name and the one most
        // OpenAI-compatible clients read; emit both so whichever a client
        // looks for is populated. Additive — clients ignore unknown fields.
        context_length: autoContextWindow,
        available: true,
        unavailable_reason: null,
      },
      {
        id: FUSION_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Fusion (panel of models answer in parallel, a judge synthesizes one answer)',
        context_window: autoContextWindow,
        context_length: autoContextWindow,
        // Available whenever auto is — fusion needs at least one routable model.
        available: autoContextWindow != null,
        unavailable_reason: autoContextWindow != null ? null : 'no_models',
      },
      ...listed.map(m => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.ownedBy,
        name: m.name,
        context_window: m.contextWindow,
        context_length: m.contextWindow,
        // Non-standard but additive: OpenAI clients ignore unknown fields.
        available: m.available === 1,
        unavailable_reason: m.available === 1 ? null : (m.enabled === 1 ? 'no_key' : 'disabled'),
      })),
    ],
  });
});


const MAX_RETRIES = 20;

// Echo-tolerant tool calls: agents replay OUR responses back as history, and
// not all of them preserve the strict OpenAI shape. `type` may be dropped
// (re-added on forward), Gemini-lineage agents (Qwen Code, AionUI) often
// send `arguments` as a parsed object instead of a JSON string, and `id` may
// be missing or empty (ids aren't a Gemini concept) — all get normalized
// below rather than 400-ing the whole session. Missing ids are synthesized
// and paired with their tool-result messages by order. (#200)
const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
  thought_signature: z.string().optional(),
});

const toolCallArgsToString = (args: string | Record<string, unknown>): string =>
  typeof args === 'string' ? args : JSON.stringify(args);

// OpenAI multimodal envelope. Clients like opencode / continue.dev send
// content as an array of typed blocks even when only text is present, and
// Gemini-lineage agents send part-style blocks like `{ "text": "..." }` with
// no `type` at all. Accept any object (or bare string) as a block; flatten to
// string for providers that don't support arrays (Cohere, Cloudflare).
// Non-text blocks pass z validation but get dropped by contentToString —
// vision/audio still isn't supported. (#200)
const contentBlockSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: contentSchema,
  name: z.string().optional(),
});

// OpenAI's newer SDKs send the system prompt as role:"developer"; accept it
// and forward as "system" — none of the routed providers know the developer
// role. (#200)
const developerMessageSchema = z.object({
  role: z.literal('developer'),
  content: contentSchema,
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: contentSchema,
  name: z.string().optional(),
});

// Assistant turns may carry empty/null content and no tool_calls — OpenAI
// accepts these in conversation history (a turn that produced no visible text,
// a placeholder, a tool turn whose content was emptied), and clients replay
// them verbatim. We accept them too and coerce empty/null content to "" before
// forwarding (see message build below) rather than 400-ing a payload OpenAI
// would take. (#165)
const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([contentSchema, z.null()]).optional(),
  name: z.string().optional(),
  // tool_calls: null (not just missing) is what several agents replay for
  // no-tool assistant turns — aionrs (AionUI's engine) writes it into every
  // session-resumed assistant echo. Treated as absent. (#200)
  tool_calls: z.array(toolCallSchema).nullable().optional(),
  // Thinking trace echoed back by a client. DeepSeek thinking models on
  // OpenCode Zen 400 ("reasoning_content in thinking mode must be passed back")
  // unless the prior turn's reasoning_content is replayed, so keep it through
  // validation instead of stripping it. See issue #255.
  reasoning_content: z.string().nullable().optional(),
});

// Tool results may arrive with null/missing content (a tool that returned
// nothing) and a missing/empty tool_call_id (Gemini-lineage agents) — coerced
// to "" and paired by order with the preceding tool_calls respectively. (#200)
const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.union([contentSchema, z.null()]).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

// Legacy function-calling shape (pre-tools OpenAI API). Old clients still
// replay these in history; forwarded as a tool message. (#200)
const functionMessageSchema = z.object({
  role: z.literal('function'),
  name: z.string().min(1),
  content: z.union([contentSchema, z.null()]).optional(),
});

const toolDefinitionSchema = z.object({
  // Some agents omit `type` on tool definitions; re-defaulted to 'function'
  // on forward. (#200)
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  // 'any' is the Mistral/Gemini wording for OpenAI's 'required'; mapped on
  // forward. (#200)
  z.enum(['none', 'auto', 'required', 'any']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const stopSchema = z.union([z.string(), z.array(z.string()).min(1).max(64)]);

function providerSafeStop(stop: string | string[] | undefined): string | string[] | undefined {
  if (!Array.isArray(stop)) return stop;
  return stop.slice(0, 4);
}

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    developerMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
    functionMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  // Some clients send max_tokens <= 0 (or -1) to mean "no limit"; accepted and
  // treated as unset on forward. (#200)
  max_tokens: z.number().int().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: stopSchema.optional(),
  stream: z.boolean().optional(),
  // Top-level tool knobs may arrive as explicit nulls from clients that
  // serialize every field of their request struct; all treated as absent
  // and never forwarded as null. (#200)
  tools: z.array(toolDefinitionSchema).nullable().optional(),
  tool_choice: toolChoiceSchema.nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  // Fusion config — only meaningful when `model` is the virtual "fusion" id.
  // Ignored for every other model. See services/fusion.ts.
  fusion: fusionConfigSchema.optional(),
});

// Upstream-error classifiers live in lib/error-classify.ts so the fusion
// service can share them without an import cycle; imported above for internal
// use and re-exported here for existing importers (routes/responses.ts,
// proxy-retry.test.ts) that pull them from this module.
export { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError };

// Pull the incremental text out of a streaming chunk for token counting.
// Must tolerate chunks that carry no `choices` array at all: some providers
// (e.g. Groq) emit usage/keepalive frames shaped like `{usage:{...}}` with no
// `choices`. Indexing `chunk.choices[0]` on those throws "Cannot read
// properties of undefined (reading '0')", which — once the SSE stream has
// started — aborts the response mid-flight with no chance to fall back.
export function streamChunkText(chunk: any): string {
  return chunk?.choices?.[0]?.delta?.content ?? '';
}

// OpenAI-compatible embeddings endpoint, routed through the embeddings family
// catalog: `model: "auto"` (or omitted) → the configured default family; a
// family name or provider model id → that family's provider chain. Failover
// only happens WITHIN a family (same model on another provider) — never across
// models, since vectors from different models are incompatible.
const EmbeddingsBody = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
  // Optional output-dimension override forwarded to providers that support MRL
  // truncation (NVIDIA NeMo NIM, Google Gemini Embedding, OpenAI v3). Validation
  // only — bounds checking happens upstream (the provider rejects out-of-range
  // values with a clear 400).
  dimensions: z.number().int().positive().optional(),
});

proxyRouter.post('/embeddings', async (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }
  const parsed = EmbeddingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input];
  try {
    const result = await runEmbeddings(parsed.data.model, inputs, parsed.data.dimensions);
    res.json({
      object: 'list',
      data: result.vectors.map((values, i) => ({ object: 'embedding', index: i, embedding: values })),
      model: result.family,
      provider: result.platform,
      usage: { prompt_tokens: result.inputTokens, total_tokens: result.inputTokens },
    });
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({ error: { message: `embedding error: ${err?.message ?? 'unknown'}`, type } });
  }
});

// OpenAI-compatible image generation. Routed through the media catalog (its own
// table, never the chat router): `model: "auto"` (or omitted) tries every enabled
// image provider in order; a provider model id pins to that one. Failover is
// across providers, never across modalities. See services/media.ts.
const ImageBody = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  n: z.number().int().positive().max(4).optional(),
  size: z.string().optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
});

function mediaErrorType(status: number): string {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  return 'server_error';
}

proxyRouter.post('/images/generations', async (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }
  const parsed = ImageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `prompt` is required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runImageGeneration(parsed.data.model, {
      prompt: parsed.data.prompt, n: parsed.data.n, size: parsed.data.size,
    });
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: result.images,
      model: result.modelId,
      provider: result.platform,
    });
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `image generation error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) } });
  }
});

// OpenAI-compatible text-to-speech. Returns raw audio bytes (OpenAI's /audio/speech
// shape). Same media-catalog routing as images.
const SpeechBody = z.object({
  model: z.string().optional(),
  input: z.string().min(1),
  voice: z.string().optional(),
  response_format: z.string().optional(),
});

proxyRouter.post('/audio/speech', async (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }
  const parsed = SpeechBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runSpeech(parsed.data.model, {
      input: parsed.data.input, voice: parsed.data.voice, format: parsed.data.response_format,
    });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('X-Provider', result.platform);
    res.send(result.audio);
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `speech error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) } });
  }
});

const CompletionBody = z.object({
  model: z.string().optional(),
  prompt: z.string(),
  suffix: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: stopSchema.optional(),
  stream: z.boolean().optional(),
});

function completionPromptToMessages(prompt: string, suffix?: string): ChatMessage[] {
  const hasSuffix = suffix !== undefined && suffix.length > 0;
  return [
    {
      role: 'system',
      content: [
        'You are a code autocomplete engine.',
        'Complete at the cursor and return only the text to insert.',
        'Do not include markdown fences, explanations, or repeat surrounding code.',
      ].join(' '),
    },
    {
      role: 'user',
      content: hasSuffix
        ? `Prefix before cursor:\n${prompt}\n\nSuffix after cursor:\n${suffix}\n\nCompletion to insert:`
        : `Prefix before cursor:\n${prompt}\n\nCompletion to insert:`,
    },
  ];
}

function completionTextFromChat(result: any): string {
  return contentToString(result?.choices?.[0]?.message?.content ?? '');
}

function completionIdFromChat(id: string | undefined): string {
  if (!id) return `cmpl-${Date.now()}`;
  return id.startsWith('cmpl-') ? id : `cmpl-${id}`;
}

function legacyCompletionChunk(route: RouteResult, chunk: any, text: string) {
  return {
    id: completionIdFromChat(chunk?.id),
    object: 'text_completion',
    created: chunk?.created ?? Math.floor(Date.now() / 1000),
    model: route.modelId,
    choices: [{
      text,
      index: chunk?.choices?.[0]?.index ?? 0,
      logprobs: null,
      finish_reason: chunk?.choices?.[0]?.finish_reason ?? null,
    }],
  };
}

// OpenAI-compatible legacy completions endpoint. Editor ghost-text clients
// (notably Continue autocomplete) still send prompt/suffix requests here; route
// those through chat models while preserving the legacy text_completion shape.
proxyRouter.post('/completions', async (req: Request, res: Response) => {
  const start = Date.now();
  const requestGroupId = getRequestGroupId(req);
  res.setHeader('X-Request-ID', requestGroupId);

  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  const parsed = CompletionBody.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({
      error: { message: `Invalid request: ${detail}`, type: 'invalid_request_error' },
    });
    return;
  }

  const { model: requestedModel, prompt, suffix, temperature, top_p, stream } = parsed.data;
  const requestedModelLabel = requestedModel ?? 'auto';
  const max_tokens = parsed.data.max_tokens != null && parsed.data.max_tokens > 0
    ? parsed.data.max_tokens : 128;
  const stop = providerSafeStop(parsed.data.stop);
  const messages = completionPromptToMessages(prompt, suffix);
  const estimatedInputTokens = messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
  // Cap the reserved output so a huge client-set max_tokens doesn't falsely
  // exclude the whole model pool (#470); input is still counted in full.
  const estimatedTotal = estimatedInputTokens + routingReserveTokens(max_tokens);

  let resolvedChain: ResolvedChain | undefined;
  if (isAutoModel(requestedModel)) {
    resolvedChain = resolveRoutingChain(requestedModel);
  }

  let preferredModel: number | undefined;
  let groupChain: ChainRow[] | undefined;

  if (!isAutoModel(requestedModel) && requestedModel) {
    const db = getDb();
    const members = isUnifyEnabled() ? resolveRequestedIdToMembers(requestedModel, getModelGroups()) : null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members);
      if (groupChain.length === 0) {
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        const reason = anyEnabled ? 'has no providers with an enabled key' : 'is disabled';
        res.status(400).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
    } else {
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        res.status(400).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
    }
  }

  const pinnedModelId = requestedModel && !isAutoModel(requestedModel) ? requestedModel : null;
  const state = newFallbackState();

  // Legacy /completions is a thin adapter over the shared fallback loop
  // (lib/fallback-loop.ts): the cooldown/skip/penalty/exhaustion machinery is
  // shared; only the text_completion request/stream translation lives here.
  await runFallbackLoop({
    maxRetries: MAX_RETRIES,
    state,
    route: () => routeRequest(
      estimatedTotal,
      state.skipKeys.size > 0 ? state.skipKeys : undefined,
      preferredModel,
      false,
      false,
      state.skipModels.size > 0 ? state.skipModels : undefined,
      groupChain ?? resolvedChain?.chain,
    ),
    dispatch: async (route, attempt) => {
      traceRouteEvent('Proxy', {
        event: attempt === 0 ? 'start' : 'next',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        requestedModel: attempt === 0 ? requestedModelLabel : undefined,
      });

      if (stream) {
        let totalOutputTokens = 0;
        let headerSent = false;
        let ttfbMs: number | null = null;
        let sawText = false;
        let upstreamFinish: string | null = null;
        const buffered: unknown[] = [];

        const flushHeaders = () => {
          if (headerSent) return;
          ttfbMs = Date.now() - start;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
          headerSent = true;
          for (const frame of buffered) res.write(`data: ${JSON.stringify(frame)}\n\n`);
          buffered.length = 0;
        };

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey,
            messages,
            route.modelId,
            { temperature, max_tokens, top_p, stop },
            quotaContextForRoute(route, 'chat/completions'),
          );

          for await (const chunk of gen) {
            const text = streamChunkText(chunk);
            if (text.length > 0) sawText = true;
            const finish = (chunk as any)?.choices?.[0]?.finish_reason;
            if (finish) upstreamFinish = finish;
            totalOutputTokens += Math.ceil(text.length / 4);
            const frame = legacyCompletionChunk(route, chunk, text);
            // Commit point: hold headers until the first real text, so a stream
            // that dies before producing any fails over invisibly.
            if (!headerSent && !sawText) {
              buffered.push(frame);
              continue;
            }
            flushHeaders();
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          }

          if (!sawText) {
            // finish_reason 'length' means the model spent the whole output
            // budget before any visible text (hidden reasoning) — fail over,
            // but skip the cooldown/penalty: not a provider-health signal.
            throw Object.assign(
              new Error(`empty completion from ${route.displayName} (legacy stream produced no text)`),
              upstreamFinish === 'length' ? { skipBench: true } : {},
            );
          }

          flushHeaders();
          res.write('data: [DONE]\n\n');
          res.end();

          recordUpstreamSuccess(route, estimatedInputTokens + totalOutputTokens);
          traceRouteEvent('Proxy', {
            event: 'ok',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            inputTokens: estimatedInputTokens,
            outputTokens: totalOutputTokens,
          });
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, ttfbMs, pinnedModelId);
          return 'done';
        } catch (streamErr: any) {
          if (headerSent) {
            console.error(`[Proxy] Mid-stream legacy completion error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            traceRouteEvent('Proxy', {
              event: 'fail',
              requestId: requestGroupId,
              attempt,
              platform: route.platform,
              model: route.modelId,
              latencyMs: Date.now() - start,
              error: sanitizeProviderErrorMessage(streamErr.message),
            });
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message), ttfbMs, pinnedModelId);
            return 'committed';
          }
          throw streamErr;
        }
      }

      const result = await route.provider.chatCompletion(
        route.apiKey,
        messages,
        route.modelId,
        { temperature, max_tokens, top_p, stop },
        quotaContextForRoute(route, 'chat/completions'),
      );

      const text = completionTextFromChat(result);
      if (!text) {
        // finish_reason 'length' = output budget consumed by hidden reasoning
        // before any visible text: fail over without a cooldown/penalty.
        throw Object.assign(
          new Error(`empty completion from ${route.displayName}`),
          result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
        );
      }

      // Usage fallback: providers that omit `usage` used to be logged as 0
      // tokens, silently undercounting analytics and the rate-limit ledger.
      // Fall back to the same chars/4 estimate the streaming path uses.
      const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
      const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);
      const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens);
      recordUpstreamSuccess(route, totalTokens);

      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.json({
        id: completionIdFromChat(result.id),
        object: 'text_completion',
        created: result.created ?? Math.floor(Date.now() / 1000),
        model: route.modelId,
        choices: [{
          text,
          index: result.choices?.[0]?.index ?? 0,
          logprobs: null,
          finish_reason: result.choices?.[0]?.finish_reason ?? 'stop',
        }],
        usage: result.usage,
      });

      traceRouteEvent('Proxy', {
        event: 'ok',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: Date.now() - start,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null, null, pinnedModelId);
      return 'done';
    },
    logFailure: (route, err, attempt) => {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      traceRouteEvent('Proxy', {
        event: 'fail',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: latency,
        error: safeError,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, null, pinnedModelId);
    },
    onFatal: (route, err, attempt) => {
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`,
          type: 'provider_error',
        },
      });
    },
    onRoutingExhausted: (lastError, routeErr, exhaustion, info) => {
      if (exhaustion) {
        if (info.attempts.length > 0) res.setHeader('X-Fallback-Attempts', String(info.attempts.length));
        res.status(exhaustion.status).json({ error: { message: exhaustion.message, type: exhaustion.type } });
      } else {
        const disposition: string[] = Array.isArray(routeErr.diagnostics) ? routeErr.diagnostics : [];
        console.warn(
          `[Proxy] legacy completions routing exhausted (no upstream tried) req=${shortRequestId(requestGroupId)} ` +
          `requested=${requestedModelLabel} candidates=${disposition.length}` +
          (disposition.length ? `:\n  ${disposition.join('\n  ')}` : ''),
        );
        res.status(routeErr.status ?? 503).json({ error: { message: routeErr.message, type: 'routing_error' } });
      }
    },
    onExhausted: (exhaustion, info) => {
      if (info.attempts.length > 0) res.setHeader('X-Fallback-Attempts', String(info.attempts.length));
      res.status(exhaustion.status).json({ error: { message: exhaustion.message, type: exhaustion.type } });
    },
  });
});

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();
  const requestGroupId = getRequestGroupId(req);
  res.setHeader('X-Request-ID', requestGroupId);

  // Authenticate with the unified API key for every proxy request, including
  // loopback callers. Browser pages can reach localhost, so socket locality is
  // not a reliable authorization boundary.
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    // Path-qualified issues ("messages.1.content: Invalid input" beats a bare
    // "Invalid input") and a server-side breadcrumb — these rejections never
    // reach the request log, which made #200 nearly undebuggable.
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    console.warn(`[proxy] 400 invalid /chat/completions request: ${detail}`);
    res.status(400).json({
      error: {
        message: `Invalid request: ${detail}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { model: requestedModel, temperature, top_p, stream } = parsed.data;
  const requestedModelLabel = requestedModel ?? 'auto';
  // Agent-tolerant knob normalization (#200): max_tokens <= 0 means "no
  // limit" in several clients → unset; tool_choice 'any' is OpenAI's
  // 'required'; tool definitions get their 'function' type re-defaulted.
  const max_tokens = parsed.data.max_tokens != null && parsed.data.max_tokens > 0
    ? parsed.data.max_tokens : undefined;
  const stop = providerSafeStop(parsed.data.stop);
  const tool_choice = parsed.data.tool_choice === 'any' ? 'required' as const : parsed.data.tool_choice ?? undefined;
  const tools = parsed.data.tools?.map(t => ({ ...t, type: 'function' as const }));
  const parallel_tool_calls = parsed.data.parallel_tool_calls ?? undefined;

  // Pairing state for id-less tool calls (#200): every tool_call id (given or
  // synthesized) queues up here; a tool message without a tool_call_id takes
  // the oldest unanswered one, which matches the single-call-per-turn flow
  // Gemini-lineage agents produce.
  const pendingToolCallIds: string[] = [];
  let syntheticIdCounter = 0;
  const takeToolCallId = (given: string | undefined): string => {
    if (given && given.length > 0) {
      const qi = pendingToolCallIds.indexOf(given);
      if (qi !== -1) pendingToolCallIds.splice(qi, 1);
      return given;
    }
    return pendingToolCallIds.shift() ?? `call_auto_${++syntheticIdCounter}`;
  };

  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      const hasToolCalls = (m.tool_calls?.length ?? 0) > 0;
      // With tool_calls, content: null is the correct OpenAI shape — keep it.
      // Without tool_calls, coerce empty/null content to "" so strict upstreams
      // don't choke on a null-content assistant turn we just accepted. (#165)
      const isEmptyContent = m.content == null
        || (typeof m.content === 'string' && m.content.length === 0)
        || (Array.isArray(m.content) && m.content.length === 0);
      const assistantContent: ChatMessage['content'] = hasToolCalls
        ? (m.content ?? null)
        : (isEmptyContent ? '' : m.content!);
      return {
        role: 'assistant',
        content: assistantContent,
        ...(m.name ? { name: m.name } : {}),
        // Replay the thinking trace verbatim. DeepSeek thinking models on
        // OpenCode Zen reject a follow-up turn that drops it; other providers
        // ignore the unknown field. Same round-trip rationale as
        // thought_signature below. (#255)
        ...(typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0
          ? { reasoning_content: m.reasoning_content }
          : {}),
        // hasToolCalls (not a bare truthiness check) so null AND empty-array
        // tool_calls are dropped rather than forwarded — strict upstreams
        // reject both shapes. (#200)
        ...(hasToolCalls ? { tool_calls: m.tool_calls!.map(tc => {
          // Normalize echo-tolerant inputs back to the strict OpenAI shape
          // before forwarding (see toolCallSchema); synthesize missing ids
          // and queue every id for order-based tool-result pairing. (#200)
          const id = tc.id && tc.id.length > 0 ? tc.id : `call_auto_${++syntheticIdCounter}`;
          pendingToolCallIds.push(id);
          return {
            id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: toolCallArgsToString(tc.function.arguments) },
            thought_signature: tc.thought_signature,
          };
        }) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        // Null/missing content (a tool that returned nothing) → "". (#200)
        content: m.content ?? '',
        tool_call_id: takeToolCallId(m.tool_call_id),
        ...(m.name ? { name: m.name } : {}),
      };
    }

    // Legacy function-calling result → forward as a tool message, paired by
    // order like an id-less tool message. (#200)
    if (m.role === 'function') {
      return {
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: takeToolCallId(undefined),
        name: m.name,
      };
    }

    return {
      // 'developer' is OpenAI's newer name for the system role — providers
      // downstream only know 'system'. (#200)
      role: m.role === 'developer' ? 'system' : m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const estimatedInputTokens = messages.reduce((sum, m) => {
    const text = contentToString(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);

  // Image requests must route to a vision-capable model. Reject up front with a
  // clear message when none is enabled, rather than silently dropping the image
  // or surfacing the generic "all models exhausted" error (#118, #125). Add a
  // rough per-image token cost so budget routing isn't skewed by content the
  // heuristic above (text-only) can't see.
  const hasImage = messageHasImage(messages);
  if (hasImage && !hasEnabledVisionModel()) {
    res.status(422).json({
      error: {
        message: 'This request includes an image, but no vision-capable model is enabled. Enable a vision model (e.g. Gemini 2.5 Flash, Llama 4 Scout) in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_vision_model',
      },
    });
    return;
  }
  const IMAGE_TOKEN_ESTIMATE = 1000;
  const imageCount = messages.reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter(b => (b as { type?: string })?.type === 'image_url' || (b as { type?: string })?.type === 'image').length : 0), 0);
  // The reserved output is capped (routingReserveTokens, #470) so an oversized
  // client max_tokens can't starve routing; input + images count in full.
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + routingReserveTokens(max_tokens);

  // Tool-bearing requests must route to a model that emits STRUCTURED
  // tool_calls. A model without real function-calling support serializes the
  // call into its text answer — the request "succeeds" but the client's tool
  // loop sees nothing, which is strictly worse than an error. Same up-front
  // gate pattern as vision above.
  const wantsTools = (tools?.length ?? 0) > 0;
  if (wantsTools && !hasEnabledToolsModel()) {
    res.status(422).json({
      error: {
        message: 'This request includes tools, but no tool-capable model is enabled. Enable a tool-calling model (e.g. GPT-OSS 120B, Gemini 3.5 Flash, GLM-4.7) in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_tools_model',
      },
    });
    return;
  }

  // ── Fusion: multi-model synthesis ──────────────────────────────────────────
  // The virtual "fusion" model fans the prompt out to a panel of diverse models
  // in parallel, then a judge synthesizes one answer. It routes each panel/judge
  // sub-call through the normal path (cooldowns, quotas, analytics), so it
  // behaves like a normal model from the client's side — just K+1x the tokens.
  // Vision is still rejected up front; tool requests run on tool-capable panel
  // members and return the first structured tool call directly.
  if (isFusionModel(requestedModel)) {
    if (hasImage) {
      res.status(422).json({ error: { message: 'Fusion does not support image input yet. Use a vision model directly.', type: 'invalid_request_error', code: 'fusion_no_vision' } });
      return;
    }
    const fusionOptions = { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls };
    const fusionConfig = parsed.data.fusion ?? {};

    if (stream) {
      // Streaming fusion: open the SSE response immediately and emit additive
      // `_fusion` frames (no `choices`, so standard OpenAI clients skip them) as
      // each panel model settles and when the judge runs — the Playground shows
      // these arriving in a collapsible trace. The final synthesized answer is
      // then streamed as normal content deltas, so plain clients still get it.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const writeFrame = (o: unknown) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch { /* socket gone */ } };
      const streamId = `fusion-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const base = { id: streamId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: FUSION_MODEL_ID };
      // Track whether the judge already streamed content so we don't re-emit it.
      let answerStarted = false;
      try {
        const { response } = await runFusion({
          messages,
          config: fusionConfig,
          options: fusionOptions,
          estimatedTokens: estimatedTotal,
          hooks: {
            // `a` already carries a sanitized error for failed slots; content is
            // the model's own answer and is forwarded as-is.
            onPanel: (a) => writeFrame({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: null }],
              _fusion: { event: 'panel', ...a },
            }),
            onJudge: (j) => writeFrame({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: null }],
              _fusion: { event: 'judge', ...j },
            }),
            // Stream the judge's synthesis live as standard content deltas, so
            // the final answer appears as it's written instead of after the wait.
            onJudgeDelta: (delta) => {
              if (!answerStarted) { writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }); answerStarted = true; }
              writeFrame({ ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
            },
          },
        });
        // best_of / single-survivor / judge-fell-back-to-best-of never streamed
        // a delta — emit the final answer as one chunk in that case.
        const finalMsg = response.choices[0]?.message;
        const finalToolCalls = (finalMsg as { tool_calls?: ChatToolCall[] } | undefined)?.tool_calls;
        const hasFinalToolCalls = Array.isArray(finalToolCalls) && finalToolCalls.length > 0;
        if (hasFinalToolCalls) {
          writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          writeFrame({ ...base, choices: [{ index: 0, delta: { tool_calls: finalToolCalls }, finish_reason: null }] });
          writeFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: response.usage });
        } else {
          if (!answerStarted) {
            const finalText = contentToString(finalMsg?.content ?? '');
            writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
            writeFrame({ ...base, choices: [{ index: 0, delta: { content: finalText }, finish_reason: null }] });
          }
          writeFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: response.usage });
        }
      } catch (err: any) {
        const message = err instanceof FusionError ? err.message : `fusion error: ${sanitizeProviderErrorMessage(err?.message)}`;
        const type = err instanceof FusionError && err.status === 429 ? 'rate_limit_error' : 'server_error';
        writeFrame({ error: { message, type } });
      }
      try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
      return;
    }

    try {
      const { response, routedVia } = await runFusion({
        messages,
        config: fusionConfig,
        options: fusionOptions,
        estimatedTokens: estimatedTotal,
      });
      res.setHeader('X-Routed-Via', routedVia);
      res.json(response);
    } catch (err: any) {
      if (err instanceof FusionError) {
        res.status(err.status).json({ error: { message: err.message, type: err.status === 429 ? 'rate_limit_error' : 'invalid_request_error' } });
      } else {
        res.status(502).json({ error: { message: `fusion error: ${sanitizeProviderErrorMessage(err?.message)}`, type: 'server_error' } });
      }
    }
    return;
  }

  // ── Response cache (services/cache.ts) ──
  // Opt-in exact-match cache. An identical earlier request is replayed from an
  // in-memory LRU without spending any provider quota. Computed here, after
  // message + sampling-param normalization but before any routing/session work,
  // so a hit short-circuits the whole pipeline. Only NON-streaming requests at a
  // cacheable temperature are eligible (v1 scope: streaming always bypasses); a
  // per-request `X-FreeLLM-Cache` header can force or bypass. Off unless enabled
  // via the RESPONSE_CACHE env var or the response_cache_enabled setting.
  const cacheDirective = parseCacheDirective(req.headers['x-freellm-cache'], req.headers['cache-control']);
  const cacheKey = (!stream && cacheActive(cacheDirective) && isCacheableTemperature(temperature))
    ? computeCacheKey({
        model: requestedModel, messages, temperature, top_p, max_tokens, tools, tool_choice,
        // Normalized stop (providerSafeStop), i.e. what is actually forwarded.
        stop,
        // The knobs below are NOT in chatCompletionSchema, so zod strips them
        // from parsed.data; read them from the raw body. They still change what
        // answer the client is asking for, so requests differing only in one of
        // them must never collide on a cached entry. Explicit null is coerced
        // to undefined (dropped from the key) to match how the proxy treats
        // null-valued optional knobs as absent.
        response_format: req.body?.response_format ?? undefined,
        n: req.body?.n ?? undefined,
        seed: req.body?.seed ?? undefined,
        presence_penalty: req.body?.presence_penalty ?? undefined,
        frequency_penalty: req.body?.frequency_penalty ?? undefined,
        logit_bias: req.body?.logit_bias ?? undefined,
        logprobs: req.body?.logprobs ?? undefined,
        top_logprobs: req.body?.top_logprobs ?? undefined,
      })
    : null;
  if (cacheKey) {
    const hit = getCachedResponse(cacheKey);
    if (hit) {
      // A hit consumes NO provider quota, so recordRequest/recordTokens are
      // deliberately skipped and the reply is not re-logged as provider usage.
      // The savings are reported separately by GET /api/cache/stats.
      res.setHeader('X-Routed-Via', 'cache');
      res.setHeader('X-FreeLLM-Cache', 'HIT');
      res.json(hit.body);
      return;
    }
  }

  // Optional client-managed session affinity (see getSessionKey). Express
  // lower-cases header names; a repeated header arrives as an array — take
  // the first value.
  const rawSessionId = req.headers['x-session-id'];
  const sessionIdHeader = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

  let resolvedChain: ResolvedChain | undefined;
  let strategyKey: string | undefined;

  if (isAutoModel(requestedModel)) {
    resolvedChain = resolveRoutingChain(requestedModel);
    strategyKey = resolvedChain.strategyKey;
  }

  // Context handoff only applies to auto-routed requests. Pinned-model requests
  // are deliberate client choices; injecting "you are taking over" there would
  // be semantically wrong.
  const isAutoRouted = !requestedModel || isAutoModel(requestedModel);
  const handoffMode = isAutoRouted ? getContextHandoffMode() : ('off' as const);
  const sessionKey = handoffMode !== 'off' ? getSessionKey(messages, sessionIdHeader, strategyKey) : '';
  if (handoffMode !== 'off' && sessionKey) {
    recordIncomingMessages(sessionKey, messages);
  }
  // A handoff can only fire when a prior model is on record for this session.
  // Check after recordIncomingMessages, which clears the prior model on a
  // fresh conversation. Stable across the retry loop (the prior model only
  // changes on a success, which returns), so compute it once here.
  const handoffPossible = handoffMode !== 'off' && !!sessionKey && hasPriorModel(sessionKey);

  // Explicit `model` field pins routing. If the catalog has no enabled row
  // matching the requested id, return 400 — silently auto-routing to a
  // different model would be surprising to OpenAI-compatible clients.
  // Sticky-session is the fallback when no `model` field was sent at all.
  let preferredModel: number | undefined;
  // When the pinned model is a unified group, this holds the group's ordered
  // members and is passed to routeRequest as the STRICT chain (no other model
  // is ever reached). Undefined for auto and legacy single-row pins.
  let groupChain: ChainRow[] | undefined;
  // Sticky scope: auto requests bucket by routing strategy; a unified group pin
  // buckets by the canonical id the client sent, so the group prefers its last
  // successful provider without leaking stickiness across groups.
  let stickyStrategyKey: string | undefined = strategyKey;

  if (isAutoModel(requestedModel)) {
    preferredModel = getStickyModel(messages, sessionIdHeader, strategyKey);
  } else if (requestedModel) {
    const db = getDb();
    // Unify ON: a requested id (canonical slug OR any provider's model_id) maps
    // to the whole logical-model group, and we route STRICTLY across only its
    // providers — failing over between them, never to a different model (#335).
    const members = isUnifyEnabled() ? resolveRequestedIdToMembers(requestedModel, getModelGroups()) : null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members);
      if (groupChain.length === 0) {
        // Distinguish a catalog-disabled model from one whose providers are
        // present but unusable (chain-disabled / no key), so the 400 stays
        // actionable and matches the legacy single-row "is disabled" wording.
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        const reason = anyEnabled ? 'has no providers with an enabled key' : 'is disabled';
        res.status(400).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
      stickyStrategyKey = requestedModel;
      const sticky = getStickyModel(messages, sessionIdHeader, stickyStrategyKey);
      // Only prefer the sticky member if it's actually IN this group — passing a
      // non-member as preferredModelDbId would make routeRequest inject an
      // off-group model and break strict pinning.
      preferredModel = (sticky != null && groupChain.some(r => r.model_db_id === sticky)) ? sticky : undefined;
    } else {
      // Unify OFF, or an id that isn't in the catalog: legacy single-row pin.
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        res.status(400).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
    }
  } else {
    preferredModel = getStickyModel(messages, sessionIdHeader, strategyKey);
  }

  // For analytics: the model id the client pinned, null when auto-routed
  // ('auto' or omitted). Logged with every request row so pinned vs auto
  // traffic and failover overrides are visible.
  const pinnedModelId = requestedModel && !isAutoModel(requestedModel) ? requestedModel : null;

  // Retry loop: on 429/rate limit, skip that model+key and try the next one.
  // The attempt iteration, cooldown/skip/penalty bookkeeping, and exhaustion
  // rendering are the shared fallback loop (lib/fallback-loop.ts). What stays
  // here is /chat/completions-specific: the response-cache MISS store, the
  // context-handoff injection, group/unified-chain routing, and the OpenAI
  // stream turn-integrity framing.
  const state = newFallbackState();

  await runFallbackLoop({
    maxRetries: MAX_RETRIES,
    state,
    route: () => {
      // When a handoff could fire this turn, pad the token estimate so the router's
      // context-window and TPM checks account for the extra system message overhead.
      // We don't know the selected model key until after routeRequest() returns, so
      // the padding is conservative on turns where injection is *possible* (a prior
      // model is on record). Turns where injection can't happen — every turn 1, and
      // sessions that never switched — pay no headroom tax.
      const routingEstimate = handoffPossible ? estimatedTotal + HANDOFF_MAX_TOKENS : estimatedTotal;
      return routeRequest(routingEstimate, state.skipKeys.size > 0 ? state.skipKeys : undefined, preferredModel, hasImage, wantsTools, state.skipModels.size > 0 ? state.skipModels : undefined, groupChain ?? resolvedChain?.chain);
    },
    dispatch: async (route, attempt) => {
    const modelKey = `${route.platform}:${route.modelId}`;
    traceRouteEvent('Proxy', {
      event: attempt === 0 ? 'start' : 'next',
      requestId: requestGroupId,
      attempt,
      platform: route.platform,
      model: route.modelId,
      requestedModel: attempt === 0 ? requestedModelLabel : undefined,
    });
    let outboundMessages = messages;
    // Extra input tokens the injected handoff adds on this turn (0 when not
    // injected). Folded into the streaming success accounting, where token
    // counts are estimated; the non-stream path uses the provider's usage,
    // which already counts the injected message.
    let injectedHandoffTokens = 0;
    if (handoffMode !== 'off' && sessionKey) {
      const handoff = maybeInjectContextHandoff({ mode: handoffMode, sessionKey, messages, selectedModelKey: modelKey });
      if (handoff.injected) console.log(`[Proxy] Context handoff injected (session ${sessionKey.slice(0, 8)}…, model switch detected)`);
      outboundMessages = handoff.messages;
      injectedHandoffTokens = handoff.injectedTokens;
    }

      if (stream) {
        // — Stream turn-integrity (#231 audit) —
        // The old loop forwarded upstream chunks verbatim and called any
        // stream that produced bytes a success. Live failure modes that
        // slipped through: in-band `{"error":...}` frames delivered as dead
        // turns, tool calls with no terminal finish_reason, inline tool-call
        // dialect emitted as text, truncations logged as success. This loop
        // validates the TURN, not the transport:
        //  - headers are held until the first real payload, so anything that
        //    dies before producing one fails over invisibly;
        //  - text that starts with an inline tool-call dialect marker is held
        //    and rescued into structured tool_calls (or failed over);
        //  - tool_call deltas are buffered, argument-repaired, and emitted as
        //    one complete chunk, always followed by finish_reason
        //    "tool_calls" — agents never see calls without a terminal reason;
        //  - a stream that ends with neither content nor calls is an empty
        //    completion and fails over like the non-stream path.
        let totalOutputTokens = 0;
        let headerSent = false;
        let ttfbMs: number | null = null;

        // Hold-window state: 'undecided' until the first text either matches
        // a dialect marker (→ 'dialect': buffer everything, rescue at end) or
        // provably cannot (→ 'passthrough': flush and stream normally).
        let mode: 'undecided' | 'passthrough' | 'dialect' = 'undecided';
        let heldText = '';
        const preamble: unknown[] = []; // role-only chunks held until flush
        const toolCallAcc = new Map<number, { id?: string; name: string; args: string }>();
        let upstreamFinish: string | null = null;
        let usageChunk: unknown = null;
        let lastMeta: { id?: string; model?: string; created?: number } = {};

        const flushHeaders = () => {
          if (headerSent) return;
          ttfbMs = Date.now() - start;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
          headerSent = true;
          for (const p of preamble) res.write(`data: ${JSON.stringify(p)}\n\n`);
          preamble.length = 0;
        };
        const mkChunk = (delta: Record<string, unknown>, finish: string | null) => ({
          id: lastMeta.id ?? `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: lastMeta.created ?? Math.floor(Date.now() / 1000),
          model: lastMeta.model ?? route.modelId,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const writeChunk = (c: unknown) => res.write(`data: ${JSON.stringify(c)}\n\n`);

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, outboundMessages, route.modelId,
            { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls },
            quotaContextForRoute(route, 'chat/completions'),
          );

          for await (const chunk of gen) {
            const anyChunk = chunk as Record<string, any>;

            // In-band upstream error frame (observed live: Groq emits
            // {"error":{...,"code":"tool_use_failed"}} inside a 200 SSE
            // stream). Before headers: retryable, the next model gets the
            // request. After: surface an error frame instead of pretending
            // the turn succeeded.
            if (anyChunk.error && !anyChunk.choices) {
              const msg = anyChunk.error.message ?? JSON.stringify(anyChunk.error).slice(0, 200);
              if (!headerSent) throw new Error(`in-band provider error from ${route.displayName}: ${msg}`);
              console.error(`[Proxy] In-band error frame from ${route.displayName} mid-stream:`, msg);
              writeChunk({ error: { message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(String(msg))}`, type: 'stream_error' } });
              try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
              traceRouteEvent('Proxy', {
                event: 'fail',
                requestId: requestGroupId,
                attempt,
                platform: route.platform,
                model: route.modelId,
                latencyMs: Date.now() - start,
                error: sanitizeProviderErrorMessage(String(msg)),
              });
              logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, `in-band error frame: ${sanitizeProviderErrorMessage(String(msg))}`, ttfbMs, pinnedModelId);
              return 'committed';
            }

            if (anyChunk.id) lastMeta = { id: anyChunk.id, model: anyChunk.model, created: anyChunk.created };

            const choice = anyChunk.choices?.[0];
            if (!choice) {
              // Usage-only frame (stream_options.include_usage) — held and
              // re-emitted after our finish chunk to preserve OpenAI ordering.
              if (anyChunk.usage) usageChunk = anyChunk;
              continue;
            }

            if (choice.finish_reason) upstreamFinish = choice.finish_reason;

            // Buffer tool_call deltas — emitted complete + repaired at end.
            for (const tc of choice.delta?.tool_calls ?? []) {
              const idx = tc.index ?? 0;
              if (!toolCallAcc.has(idx)) toolCallAcc.set(idx, { id: undefined, name: '', args: '' });
              const acc = toolCallAcc.get(idx)!;
              if (tc.id && !acc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }

            normalizeOutboundContent(chunk);
            sanitizeResponse(chunk);
            const text = typeof choice.delta?.content === 'string' ? choice.delta.content : '';

            if (text.length === 0) {
              // Role preamble / keep-alive: hold until first payload decides
              // the mode, forward afterwards. tool_calls and finish_reason are
              // stripped — both are re-emitted complete at the end (OpenRouter
              // attaches tool_call deltas to chunks that also carry role/
              // reasoning keys; forwarding them raw would duplicate the call).
              if (choice.delta && Object.keys(choice.delta).some(k => k !== 'content' && k !== 'tool_calls' && choice.delta[k] != null)) {
                const cleaned = { ...anyChunk, choices: [{ ...choice, delta: { ...choice.delta, tool_calls: undefined }, finish_reason: null }] };
                if (headerSent) writeChunk(cleaned); else preamble.push(cleaned);
              }
              continue;
            }

            totalOutputTokens += Math.ceil(text.length / 4);

            if (mode === 'passthrough') {
              writeChunk({ ...anyChunk, choices: [{ ...choice, delta: { ...choice.delta, tool_calls: undefined }, finish_reason: null }] });
              continue;
            }

            heldText += text;
            if (mode === 'dialect') continue;

            const probe = heldText.trimStart();
            if (startsWithDialectMarker(probe)) {
              mode = 'dialect';
            } else if (!couldBecomeDialectMarker(probe) || probe.length > 256) {
              mode = 'passthrough';
              flushHeaders();
              writeChunk(mkChunk({ content: heldText }, null));
              heldText = '';
            }
            // else: still a strict prefix of a marker — keep holding.
          }

          // — Stream ended cleanly (provider saw [DONE] or a finish_reason) —

          // Assemble buffered tool calls: synthesize missing ids, repair
          // double-encoded arguments against the request's schemas, drop
          // calls whose args still aren't valid JSON.
          const schemas = toolSchemaMap(tools);
          let syntheticStreamIds = 0;
          const completedCalls = [...toolCallAcc.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, acc]) => ({
              id: acc.id && acc.id.length > 0 ? acc.id : `call_stream_${++syntheticStreamIds}`,
              type: 'function' as const,
              function: { name: acc.name, arguments: repairToolArguments(acc.args || '{}', schemas.get(acc.name)) },
            }))
            .filter(c => { try { JSON.parse(c.function.arguments); return c.function.name.length > 0; } catch { return false; } });

          // Dialect rescue: the held text is an inline tool call in some
          // model's private syntax. Parse it into structured calls or treat
          // the turn as dead (headers were never sent in dialect mode, so
          // failing over is free).
          if (mode === 'dialect' || (mode === 'undecided' && heldText.length > 0 && containsDialectMarker(heldText))) {
            const rescue = rescueInlineToolCalls(heldText, new Set((tools ?? []).map(t => t.function.name)));
            if (rescue.detected) {
              if (!rescue.calls) throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${heldText.slice(0, 120)}`);
              let rescuedIds = 0;
              for (const c of rescue.calls) {
                completedCalls.push({ id: `call_rescued_${++rescuedIds}`, type: 'function', function: { name: c.name, arguments: repairToolArguments(c.arguments, schemas.get(c.name)) } });
              }
              heldText = rescue.cleanText;
              console.log(`[Proxy] Rescued ${rescuedIds} inline tool call(s) from ${route.displayName} into structured tool_calls`);
            }
          }

          const hasText = headerSent || heldText.trim().length > 0;
          if (!hasText && completedCalls.length === 0) {
            // Nothing usable came out — same failover semantics as the
            // non-stream empty-completion path. Headers can't have been sent
            // (header flush requires payload), so the client never notices.
            // finish_reason 'length' = the model spent the whole output budget
            // on hidden reasoning before any visible text: fail over, but skip
            // the cooldown/penalty (not a provider-health signal).
            throw Object.assign(
              new Error(`empty completion from ${route.displayName} (stream produced no content and no tool calls)`),
              upstreamFinish === 'length' ? { skipBench: true } : {},
            );
          }

          flushHeaders();
          if (heldText.length > 0) {
            writeChunk(mkChunk({ content: heldText }, null));
          }
          if (completedCalls.length > 0) {
            writeChunk(mkChunk({ tool_calls: completedCalls.map((c, i) => ({ index: i, ...c })) }, null));
            totalOutputTokens += Math.ceil(completedCalls.reduce((n, c) => n + c.function.arguments.length, 0) / 4);
          }
          // Terminal finish_reason, ALWAYS present: calls win over a sloppy
          // upstream 'stop'; 'length'/'content_filter' survive for pure-text
          // turns; missing upstream reason is synthesized.
          const finish = completedCalls.length > 0
            ? 'tool_calls'
            : (upstreamFinish && upstreamFinish !== 'tool_calls' ? upstreamFinish : 'stop');
          writeChunk(mkChunk({}, finish));
          if (usageChunk) writeChunk(usageChunk);
          res.write('data: [DONE]\n\n');
          res.end();

          recordUpstreamSuccess(route, estimatedInputTokens + injectedHandoffTokens + totalOutputTokens);
          setStickyModel(messages, route.modelDbId, sessionIdHeader, stickyStrategyKey);
          if (handoffMode !== 'off' && sessionKey) recordSuccessfulModel({ sessionKey, modelKey });
          traceRouteEvent('Proxy', {
            event: 'ok',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            inputTokens: estimatedInputTokens + injectedHandoffTokens,
            outputTokens: totalOutputTokens,
          });
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens + injectedHandoffTokens, totalOutputTokens, Date.now() - start, null, ttfbMs, pinnedModelId);
          return 'done';
        } catch (streamErr: any) {
          if (headerSent) {
            // Mid-stream error after real payload reached the client — finish
            // the SSE response honestly instead of leaving the client hanging.
            console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            traceRouteEvent('Proxy', {
              event: 'fail',
              requestId: requestGroupId,
              attempt,
              platform: route.platform,
              model: route.modelId,
              latencyMs: Date.now() - start,
              error: sanitizeProviderErrorMessage(streamErr.message),
            });
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message), ttfbMs, pinnedModelId);
            return 'committed';
          }
          // Headers never sent — bubble to the shared loop, which cooldowns this
          // model+key and tries the next one. Covers upstream HTTP errors, in-band
          // error frames, abrupt EOF, stalls, empty completions, and unparseable
          // dialect turns alike.
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, outboundMessages, route.modelId,
          { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls },
          quotaContextForRoute(route, 'chat/completions'),
        );

        // Empty completion (no text, no tool calls) → fail over rather than
        // return a transport-level "success" the caller can't act on. Mirrors
        // the zero-chunk streaming case above. Throwing hands it to the shared
        // loop, which classifies "empty completion" as retryable and applies the
        // same cooldown/skip/penalty bookkeeping as every other failure.
        const respMsg = result.choices?.[0]?.message;
        const respText = contentToString(respMsg?.content ?? '');
        if (!respText && (respMsg?.tool_calls?.length ?? 0) === 0) {
          // finish_reason 'length' = the model spent the whole output budget on
          // hidden reasoning before any visible text (observed live: 5 of 11
          // hops in one chain). Still fail over, but skipBench tells the shared
          // loop not to cooldown/penalize a healthy model for a truncated turn.
          throw Object.assign(
            new Error(`empty completion from ${route.displayName}`),
            result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
          );
        }

        // Inline tool-call dialect rescue (#231 audit): a tool-bearing
        // request answered with the call serialized as TEXT (a mid-
        // conversation model switch makes the new model imitate the previous
        // model's private syntax). Re-parse it into structured tool_calls so
        // the client's agent loop keeps working; a detected-but-unparseable
        // dialect is a dead turn and fails over like an empty completion.
        if (wantsTools && respMsg && (respMsg.tool_calls?.length ?? 0) === 0 && respText) {
          const rescue = rescueInlineToolCalls(respText, new Set((tools ?? []).map(t => t.function.name)));
          if (rescue.detected) {
            if (!rescue.calls) {
              throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${respText.slice(0, 120)}`);
            }
            const schemas = toolSchemaMap(tools);
            respMsg.tool_calls = rescue.calls.map((c, i) => ({
              id: `call_rescued_${i + 1}`,
              type: 'function' as const,
              function: { name: c.name, arguments: repairToolArguments(c.arguments, schemas.get(c.name)) },
            }));
            respMsg.content = rescue.cleanText.length > 0 ? rescue.cleanText : null;
            if (result.choices?.[0]) result.choices[0].finish_reason = 'tool_calls';
            console.log(`[Proxy] Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName} into structured tool_calls`);
          }
        }

        // Usage fallback: providers that omit `usage` used to be logged as 0
        // tokens, silently undercounting analytics and the rate-limit ledger.
        // Fall back to the same chars/4 estimate the streaming path uses (tool
        // arguments included, mirroring the stream accounting).
        const respToolArgChars = (respMsg?.tool_calls ?? []).reduce((n, tc) => n + (tc?.function?.arguments?.length ?? 0), 0);
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens
          ?? Math.ceil((contentToString(respMsg?.content ?? '').length + respToolArgChars) / 4);
        const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens);
        recordUpstreamSuccess(route, totalTokens);
        // Use stickyStrategyKey (not the global strategyKey) so a group-pinned
        // request writes its sticky entry under the SAME key the next turn reads
        // from (set to the requested model id at the top of the loop). Matches the
        // streaming success path; without it, "prefer last successful provider"
        // is lost for non-streaming group-pinned sessions. (#341 review)
        setStickyModel(messages, route.modelDbId, sessionIdHeader, stickyStrategyKey);
        if (handoffMode !== 'off' && sessionKey) recordSuccessfulModel({ sessionKey, modelKey });

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        // Repair double-encoded tool arguments against the request's tool
        // schemas (e.g. GLM emitting an array parameter as a JSON string),
        // so strict clients don't reject the call. Schema-gated — a true
        // string parameter is never touched. See lib/tool-args.ts.
        if (respMsg?.tool_calls?.length) {
          const schemas = toolSchemaMap(tools);
          for (const tc of respMsg.tool_calls) {
            if (tc?.function?.arguments != null) {
              tc.function.arguments = repairToolArguments(tc.function.arguments, schemas.get(tc.function.name));
            }
          }
        }
        // Normalize array-shaped message.content to a string on the way out (#166).
        const outboundBody = sanitizeResponse(normalizeOutboundContent(result));
        res.setHeader('X-FreeLLM-Cache', cacheKey ? 'MISS' : 'OFF');
        res.json(outboundBody);

        // Cache the freshly-generated answer so an identical later request is
        // served from memory without spending another free-tier slot. A
        // truncated turn (finish_reason 'length') is NOT cached: replaying a
        // cut-off answer forever would be worse than regenerating.
        if (cacheKey && result.choices?.[0]?.finish_reason !== 'length') {
          storeCachedResponse(cacheKey, {
            body: outboundBody,
            platform: route.platform,
            modelId: route.modelId,
            keyId: route.keyId,
            promptTokens,
            completionTokens,
          });
        }

        traceRouteEvent('Proxy', {
          event: 'ok',
          requestId: requestGroupId,
          attempt,
          platform: route.platform,
          model: route.modelId,
          latencyMs: Date.now() - start,
          inputTokens: promptTokens,
          outputTokens: completionTokens,
        });
        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null, null, pinnedModelId);
        return 'done';
      }
    },
    logFailure: (route, err, attempt) => {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      traceRouteEvent('Proxy', {
        event: 'fail',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: latency,
        error: safeError,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, null, pinnedModelId);
    },
    onFatal: (route, err, attempt) => {
      // Non-retryable error (bare 4xx, etc.): don't retry.
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`,
          type: 'provider_error',
        },
      });
    },
    onRoutingExhausted: (lastError, routeErr, exhaustion, info) => {
      // No more models available.
      if (exhaustion) {
        if (info.attempts.length > 0) res.setHeader('X-Fallback-Attempts', String(info.attempts.length));
        res.status(exhaustion.status).json({ error: { message: exhaustion.message, type: exhaustion.type } });
      } else {
        // Synchronous exhaustion: the router rejected every candidate before any
        // upstream was tried, so this is the ONLY place the per-model disposition
        // is recorded. Without it a routing_error 429 is opaque — you can't tell a
        // genuinely dry pool from cooldowns/quota/context narrowing (issue _1).
        const disposition: string[] = Array.isArray(routeErr.diagnostics) ? routeErr.diagnostics : [];
        console.warn(
          `[Proxy] routing exhausted (no upstream tried) req=${shortRequestId(requestGroupId)} ` +
          `requested=${requestedModelLabel} candidates=${disposition.length}` +
          (disposition.length ? `:\n  ${disposition.join('\n  ')}` : ''),
        );
        res.status(routeErr.status ?? 503).json({ error: { message: routeErr.message, type: 'routing_error' } });
      }
    },
    onExhausted: (exhaustion, info) => {
      if (info.attempts.length > 0) res.setHeader('X-Fallback-Attempts', String(info.attempts.length));
      res.status(exhaustion.status).json({ error: { message: exhaustion.message, type: exhaustion.type } });
    },
  });
});

// logRequest moved to lib/request-log.ts (shared with the fusion service to
// avoid an import cycle); imported above for internal use and re-exported here
// for routes/responses.ts which imports it from this module.
export { logRequest };
