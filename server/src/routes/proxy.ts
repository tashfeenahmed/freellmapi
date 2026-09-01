import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, ChatToolCall, ModelListRow, TokenUsage } from '@freellmapi/shared/types.js';
import { routeRequest, resolveRoutingChain, resolveModelGroupCandidates, resolveStickyPreference, recordRateLimitHit, recordSuccess, hasEnabledVisionModel, hasEnabledToolsModel, hasOtherUsableKey, routingReserveTokens, type RouteResult, type ResolvedChain, type ChainRow } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit, PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_FORBIDDEN_COOLDOWN_MS, learnLimitFromError } from '../services/ratelimit.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { runImageGeneration, runVideoGeneration, runSpeech, runTranscription, MediaError, MAX_TRANSCRIPTION_BYTES } from '../services/media.js';
import multer from 'multer';
import { getDb } from '../db/index.js';
import { resolveAuth, prependSystemPrompt, type ResolvedAuth } from '../lib/system-prompt.js';
import { contentToString, messageHasImage, normalizeOutboundContent, sanitizeResponse, truncateMessagesForGithub } from '../lib/content.js';
import { normalizeMessageImages } from '../lib/image-normalize.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { invalidToolArgumentsError, invalidToolCallReasons, isToolArgumentValidationEnabled } from '../lib/tool-validate.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import { getContextHandoffMode, recordIncomingMessages, maybeInjectContextHandoff, recordSuccessfulModel, hasPriorModel, HANDOFF_MAX_TOKENS } from '../services/context-handoff.js';
import { isFusionModel, runFusion, fusionConfigSchema, FusionError, FUSION_MODEL_ID } from '../services/fusion.js';
import { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError, isClientAbortError, newClientAbortError, newHedgeAbortError, isUpstreamClassificationOutput } from '../lib/error-classify.js';
import { logRequest } from '../lib/request-log.js';
import { observeServedModel } from '../lib/served-model.js';
import { parseCacheDirective, cacheActive, isCacheableTemperature, computeCacheKey, getCachedResponse, storeCachedResponse } from '../services/cache.js';
import { normalizeIdempotencyKey, hashIdempotencyKey, computeIdempotencyFingerprint, lookupIdempotencyReplay, storeIdempotencyResult } from '../services/idempotency.js';
import { runFallbackLoop, newFallbackState, recordUpstreamSuccess, exhaustedRetryError, setFallbackHeaders, exhaustionErrorPayload, setExhaustionHeaders, type AttemptRecord } from '../lib/fallback-loop.js';
import { routedViaValue, safeHeaderValue } from '../lib/header-value.js';
import { applyTokenBudget, tokenBudgetMessage } from '../lib/guardrails.js';
import { samplingParamSchemaFields, pickSamplingParams, supportedParametersForPlatforms } from '../lib/sampling-params.js';
import { enforceJsonContent } from '../lib/structured-output.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { inferQuotaPoolKey, type QuotaObservationContext } from '../services/provider-quota.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdForDispatch } from '../services/model-groups.js';
import { buildModelListing } from '../services/model-listing.js';
import { claudeFamilyDiscoveryEntries } from '../services/anthropic-map.js';
import { compressRequest, formatCompressionHeader } from '../services/compression/pipeline.js';

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

// timingSafeStringEqual moved to lib/system-prompt.ts (resolveAuth needs it
// and importing it back from this route would be a cycle). Re-exported here
// for existing importers (anthropic, gemini, mcp, ollama, status, url-tokens).
export { timingSafeStringEqual } from '../lib/system-prompt.js';

// Shared auth gate for the /v1 inference endpoints (#411): accepts the unified
// key (default behavior, no enforced prompt) or an enabled client-profile key
// (which may carry a server-enforced system prompt). Profile keys are ONLY
// valid here — never on the /api dashboard surface. Writes the 401 itself so
// call sites can simply bail on null.
function requireInferenceAuth(req: Request, res: Response): ResolvedAuth | null {
  const auth = resolveAuth(extractApiToken(req));
  if (!auth) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return null;
  }
  return auth;
}

// Extract the unified API key from an incoming request. Accepts both the
// OpenAI Bearer, Anthropic x-api-key, and Gemini x-goog-api-key headers.
// Query credentials remain scoped to the Gemini router.
export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers['x-api-key'];
  const xApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = xApiKey?.trim();
  if (trimmed) return trimmed;
  const googleHeader = req.headers['x-goog-api-key'];
  const googleKey = Array.isArray(googleHeader) ? googleHeader[0] : googleHeader;
  return googleKey?.trim() || undefined;
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

// #797: per-session memory of the last assistant turn's thinking trace.
// DeepSeek thinking models on OpenCode Zen 400 on a follow-up turn unless the
// prior `reasoning_content` is replayed; opencode (and other AI-SDK clients)
// strip the field when re-serializing history, so the proxy restores what it
// itself returned last turn. Non-thinking sessions never record an entry.
// The trace is stored WITH the model key that produced it: a remembered trace
// is only ever replayed to that same platform+model, so a session that fails
// over (or auto-routes elsewhere on the next turn) never carries one model's
// thinking into another provider's payload.
const reasoningMemory = new Map<string, { reasoning: string; modelKey: string; lastUsed: number }>();
const REASONING_TTL_MS = 30 * 60 * 1000; // 30 min, matching sticky sessions

// Platforms that reject an assistant turn WITHOUT `reasoning_content` once the
// conversation is in thinking mode, i.e. where the field has to be present on
// every assistant message and older turns need an empty-string filler. Only
// OpenCode Zen is on record for this (the DeepSeek thinking semantics behind
// #255/#797); everywhere else only the turn we actually have a trace for is
// touched, so no other provider's bytes change.
const PLATFORMS_REQUIRING_REASONING_ECHO = new Set(['opencode']);

function rememberReasoning(sessionKey: string | undefined, modelKey: string, reasoning: string) {
  if (!sessionKey || !reasoning) return;
  reasoningMemory.set(sessionKey, { reasoning, modelKey, lastUsed: Date.now() });
  if (reasoningMemory.size > 500) {
    const now = Date.now();
    for (const [key, entry] of reasoningMemory) {
      if (now - entry.lastUsed > REASONING_TTL_MS) reasoningMemory.delete(key);
    }

    // Hard cap: traces are far bigger than a sticky entry, so an all-fresh map
    // must not grow without bound. Evict oldest by lastUsed, as setStickyModel does.
    if (reasoningMemory.size > 1000) {
      const entries = [...reasoningMemory.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const toEvict = reasoningMemory.size - 1000;
      for (let i = 0; i < toEvict; i++) reasoningMemory.delete(entries[i][0]);
    }
  }
}

// The remembered trace for this session, or undefined when there is none, it
// expired, or it came from a different model than the one about to be called.
// An expired entry is dropped on read rather than left for the size sweep.
export function clearReasoningMemory() {
  reasoningMemory.clear();
  stickySessionMap.clear();
}

function rememberedReasoningFor(sessionKey: string, modelKey: string): string | undefined {
  if (!sessionKey) return undefined;
  const entry = reasoningMemory.get(sessionKey);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > REASONING_TTL_MS) {
    reasoningMemory.delete(sessionKey);
    return undefined;
  }
  return entry.modelKey === modelKey ? entry.reasoning : undefined;
}

// Put the remembered trace back on the newest assistant turn that lost it.
// Returns a NEW array (with new objects for the messages it changes) whenever
// it changes anything — the caller's `messages` are what handoff recording,
// logging, compression and the response cache already saw, and must not move
// under them. Returns the input untouched when there is nothing to restore.
function restoreSessionReasoning(messages: ChatMessage[], reasoning: string, platform: string): ChatMessage[] {
  // Older assistant turns get "" — DeepSeek requires the field on every
  // assistant message, and an empty string satisfies it (see opencode issue
  // #24104). Only for platforms that actually enforce that; elsewhere just the
  // one turn we have a real trace for is touched.
  const fillOlderTurns = PLATFORMS_REQUIRING_REASONING_ECHO.has(platform);
  let restored: ChatMessage[] | undefined;
  let restoredLatest = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    // The client kept the field — nothing was dropped, leave it alone.
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) continue;
    restored ??= [...messages];
    restored[i] = { ...m, reasoning_content: restoredLatest ? '' : reasoning };
    if (!restoredLatest && !fillOlderTurns) break;
    restoredLatest = true;
  }
  return restored ?? messages;
}

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
  if (!requireInferenceAuth(req, res)) return;

  // By default we return the WHOLE catalog (one row per model id), each tagged
  // with whether it is currently usable, so a client can see everything and know
  // what's connected vs. disabled/keyless (#242). `?available=true` (aliases
  // `?connected=true`, `?ready=true`) narrows the list to only models that can
  // serve a request right now — the previous default behavior. The `ready`
  // alias is the machine-readable filter a meta-gateway uses (#433) to ask
  // "which models can this instance actually serve now". `available` is computed as
  // "enabled AND an enabled key can serve it"; dedup prefers an available
  // instance of a model id over a disabled/keyless one.
  // Shared catalog listing (one source of truth for the OpenAI and Anthropic
  // /v1/models endpoints — see services/model-listing.ts). `autoContextWindow`
  // is the honest ceiling for the virtual "auto" model: the largest context
  // window among models that can serve a request right now. Advertising null
  // makes OpenAI-compatible clients (opencode, Continue) fall back to their own
  // conservative default and truncate long inputs before they reach us (#282).
  const { models: allListed, autoContextWindow } = buildModelListing();

  const q = String(req.query.available ?? req.query.connected ?? req.query.ready ?? '').toLowerCase();
  const onlyAvailable = q === '1' || q === 'true' || q === 'yes';
  const listed = onlyAvailable ? allListed.filter(m => m.available === 1) : allListed;

  // Named fallback chains (#960/#895): every user-defined profile is exposed
  // as an `auto:<name>` model so a client can pick a specific fallback chain
  // per request (auto:my-group) instead of only the active one. Available iff
  // at least one model in that profile's chain can serve a request right now.
  const profileRows = getDb().prepare(`
    SELECT p.id, p.name,
           EXISTS (
             SELECT 1
             FROM profile_models pm
             JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
             WHERE pm.profile_id = p.id AND pm.enabled = 1
               AND EXISTS (
                 SELECT 1 FROM api_keys k
                 WHERE k.platform = m.platform AND k.enabled = 1
                   AND (m.key_id IS NULL OR k.id = m.key_id)
               )
           ) AS usable,
           (SELECT MAX(m2.context_window)
            FROM profile_models pm2
            JOIN models m2 ON m2.id = pm2.model_db_id AND m2.enabled = 1
            WHERE pm2.profile_id = p.id AND pm2.enabled = 1) AS max_ctx
    FROM profiles p
    WHERE p.type = 'custom'
    ORDER BY p.sort_order, p.id
  `).all() as { id: number; name: string; usable: number; max_ctx: number | null }[];

  // Claude-family discovery entries (#880). The Anthropic-shaped GET /v1/models
  // in routes/anthropic.ts already lists one id per Claude family so clients
  // that only accept Claude-looking ids can discover anything at all — but that
  // handler only answers when the caller sends an `anthropic-version` header.
  // Claude Desktop's gateway picker fetches this path WITHOUT that header, so
  // it fell through to the OpenAI-shaped listing below and still saw zero
  // Claude-shaped ids. Emit the same entries here, from the same builder, so
  // both shapes agree on what the gateway will serve. Listed only when
  // something can actually serve them, and never when the id would collide
  // with a real catalog row.
  const listedIds = new Set(listed.map(m => m.id));
  const claudeFamilyEntries = allListed.some(m => m.available === 1)
    ? claudeFamilyDiscoveryEntries()
      .filter(a => !listedIds.has(a.id))
      .map(a => ({
        id: a.id,
        object: 'model' as const,
        created: 0,
        owned_by: 'freellmapi',
        name: a.displayName,
        context_window: autoContextWindow,
        context_length: autoContextWindow,
        available: true,
        unavailable_reason: null,
      }))
    : [];

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
      ...claudeFamilyEntries,
      ...profileRows.map(p => ({
        id: `auto:${p.name.toLowerCase()}`,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: `Auto: ${p.name} (named fallback chain)`,
        context_window: p.max_ctx,
        context_length: p.max_ctx,
        available: p.usable === 1,
        unavailable_reason: p.usable === 1 ? null : 'no_models',
      })),
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
        // OpenRouter's field name; agents use it to pick knobs per model. For
        // a unify group this is the intersection over member platforms — a
        // param is only advertised when every platform the router might pick
        // honors it.
        supported_parameters: supportedParametersForPlatforms(m.platforms, { tools: m.supportsTools }),
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
  stream_options: z.object({
    include_usage: z.boolean().optional(),
  }).optional(),
  // Top-level tool knobs may arrive as explicit nulls from clients that
  // serialize every field of their request struct; all treated as absent
  // and never forwarded as null. (#200)
  tools: z.array(toolDefinitionSchema).nullable().optional(),
  tool_choice: toolChoiceSchema.nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  // Fusion config — only meaningful when `model` is the virtual "fusion" id.
  // Ignored for every other model. See services/fusion.ts.
  fusion: fusionConfigSchema.optional(),
  // Extended sampling + structured-output params (top_k, seed, penalties,
  // logit_bias, logprobs, response_format, max_completion_tokens…), forwarded
  // per the platform policy in lib/sampling-params.ts.
  ...samplingParamSchemaFields,
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

// Pull the incremental reasoning text out of a streaming chunk. Reasoning
// models stream thinking via `reasoning_content` (Z.ai, DeepSeek-style — the
// <think> extractor in base.ts normalizes inline tags into the same field) or
// `reasoning` (Ollama-style) before the first visible answer token; both
// spellings must count for ttfb and output-token estimates. Same shape
// tolerance as streamChunkText. (#764)
export function streamReasoningText(chunk: any): string {
  const delta = chunk?.choices?.[0]?.delta;
  const r = delta?.reasoning_content ?? delta?.reasoning;
  return typeof r === 'string' ? r : '';
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
  if (!requireInferenceAuth(req, res)) return;
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
  if (status === 400 || status === 413) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  return 'server_error';
}

proxyRouter.post('/images/generations', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
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

// Text-to-video generation. Providers may use a synchronous binary response
// (Pollinations) or an asynchronous queue internally (Hugging Face/fal.ai), but
// this gateway presents one bounded request and returns the completed MP4.
const VideoBody = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  duration: z.number().int().min(1).max(120).optional(),
  aspect_ratio: z.enum(['16:9', '9:16']).optional(),
  image: z.string().url().optional(),
  seed: z.number().int().min(-1).max(2_147_483_647).optional(),
  audio: z.boolean().optional(),
});

proxyRouter.post('/videos/generations', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = VideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: 'Invalid request: `prompt` is required and video options must use supported values',
        type: 'invalid_request_error',
      },
    });
    return;
  }
  // A video job runs for minutes, so a caller that hangs up must actually stop
  // the work: without this the gateway would keep polling the provider and then
  // fail over to a second one, both charged to the operator, for a response
  // nobody is waiting for. 'close' also fires on normal completion, which
  // writableEnded distinguishes.
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientAbort.abort();
  });
  try {
    const result = await runVideoGeneration(parsed.data.model, {
      prompt: parsed.data.prompt,
      duration: parsed.data.duration,
      aspectRatio: parsed.data.aspect_ratio,
      image: parsed.data.image,
      seed: parsed.data.seed,
      audio: parsed.data.audio,
    }, clientAbort.signal);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.setHeader('X-Model', safeHeaderValue(result.modelId));
    res.send(result.video);
  } catch (err: any) {
    // Nothing to report to a socket that is already gone.
    if (clientAbort.signal.aborted || res.writableEnded) return;
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({
      error: { message: `video generation error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) },
    });
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
  if (!requireInferenceAuth(req, res)) return;
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
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.send(result.audio);
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `speech error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) } });
  }
});

// OpenAI-compatible speech-to-text (/v1/audio/transcriptions). Multipart form
// upload, held in memory only (multer memoryStorage — audio bytes never touch
// disk), routed through the STT provider chain in services/media.ts with the
// same key/failover/cooldown machinery as the other media endpoints. The STT
// registry (media_models, modality='transcription') is maintained by the
// published catalog's `transcriptionModels` array via catalog-sync, plus any
// OpenAI-compatible endpoint the operator registered themselves through
// POST /api/media/custom; on an install that has never synced one and has no
// custom row, the endpoint answers 503 with code 'no_transcription_models'.
//
// response_format: 'json' (default, {"text": ...}), 'text' (plain string),
// 'verbose_json' (OpenAI verbose shape when the provider returns segments,
// graceful fallback to the plain json shape otherwise), 'vtt' (only from
// providers that produce it natively — Cloudflare whisper). 'srt' is not
// produced natively by any configured provider and is refused with 400
// unsupported_format rather than synthesized.
const transcriptionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TRANSCRIPTION_BYTES, files: 1 },
});

const TRANSCRIPTION_FORMATS = new Set(['json', 'text', 'verbose_json', 'srt', 'vtt']);

function transcriptionBadRequest(res: Response, message: string, code?: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', ...(code ? { code } : {}) } });
}

proxyRouter.post('/audio/transcriptions', (req: Request, res: Response, next) => {
  // Auth before the multipart body is parsed: an unauthenticated caller's
  // upload is never buffered.
  if (!requireInferenceAuth(req, res)) return;
  transcriptionUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: {
            message: `Audio file too large: the maximum upload size is ${MAX_TRANSCRIPTION_BYTES / (1024 * 1024)} MB.`,
            type: 'invalid_request_error',
            code: 'file_too_large',
          },
        });
        return;
      }
      transcriptionBadRequest(res, 'Malformed multipart/form-data upload.');
      return;
    }
    next();
  });
}, async (req: Request, res: Response) => {
  const file = req.file;
  if (!file || !file.buffer?.length) {
    transcriptionBadRequest(res, 'Invalid request: `file` is required (multipart/form-data audio upload).');
    return;
  }
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model) {
    transcriptionBadRequest(res, "Invalid request: `model` is required (use 'whisper-1' or 'auto' to let the router decide).");
    return;
  }
  const rawFormat = typeof req.body?.response_format === 'string' ? req.body.response_format.trim() : '';
  const responseFormat = rawFormat || 'json';
  if (!TRANSCRIPTION_FORMATS.has(responseFormat)) {
    transcriptionBadRequest(res, `Invalid response_format '${responseFormat}'. Supported: json, text, verbose_json, vtt.`);
    return;
  }
  if (responseFormat === 'srt') {
    transcriptionBadRequest(
      res,
      "response_format 'srt' is not supported: no configured provider produces srt natively. Use json, text, verbose_json, or vtt.",
      'unsupported_format',
    );
    return;
  }
  let temperature: number | undefined;
  if (req.body?.temperature !== undefined && req.body.temperature !== '') {
    temperature = Number(req.body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      transcriptionBadRequest(res, 'Invalid temperature: must be a number between 0 and 1.');
      return;
    }
  }
  const language = typeof req.body?.language === 'string' && req.body.language.trim() ? req.body.language.trim() : undefined;
  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt ? req.body.prompt : undefined;

  try {
    const result = await runTranscription(model, {
      file: file.buffer,
      filename: file.originalname || 'audio',
      mimeType: file.mimetype,
      language,
      prompt,
      temperature,
      responseFormat,
    });
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.setHeader('X-Model', safeHeaderValue(result.modelId));
    if (responseFormat === 'text') {
      res.type('text/plain').send(result.text);
      return;
    }
    if (responseFormat === 'vtt') {
      res.type('text/vtt').send(result.vtt ?? '');
      return;
    }
    if (responseFormat === 'verbose_json' && Array.isArray(result.segments) && result.segments.length > 0) {
      res.json({
        task: 'transcribe',
        language: result.language ?? null,
        duration: result.duration ?? null,
        text: result.text,
        segments: result.segments,
      });
      return;
    }
    res.json({ text: result.text });
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    const code = err instanceof MediaError && err.code ? { code: err.code } : {};
    res.status(httpStatus).json({ error: { message: `transcription error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status), ...code } });
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

// Non-streaming counterpart of streamReasoningText: reasoning models attach
// thinking to the completed message as `reasoning_content` or `reasoning`.
// Included in the chars/4 output estimate so analytics and the rate-limit
// ledger aren't undercounted for thinking models. (#764)
export function completionReasoningText(result: any): string {
  const msg = result?.choices?.[0]?.message;
  const r = msg?.reasoning_content ?? msg?.reasoning;
  return typeof r === 'string' ? r : '';
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

  const auth = requireInferenceAuth(req, res);
  if (!auth) return;

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
  // A profile's enforced prompt goes ahead of the autocomplete system message.
  const messages = prependSystemPrompt(completionPromptToMessages(prompt, suffix), auth.systemPrompt);
  const estimatedInputTokens = messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
  // Cap the reserved output so a huge client-set max_tokens doesn't falsely
  // exclude the whole model pool (#470); input is still counted in full. The
  // reserve is passed to the router separately: it is an exact count and must
  // not be inflated by the context-window safety margin (#956 review).
  const outputReserve = routingReserveTokens(max_tokens);
  const estimatedTotal = estimatedInputTokens + outputReserve;

  // Guardrail: per-request token budget (request_max_tokens_budget, default
  // off). max_tokens always has a value on this surface (default 128), so a
  // violation can only reject — no capping branch.
  const budgetCheck = applyTokenBudget(estimatedInputTokens, max_tokens);
  if (budgetCheck.rejection) {
    res.status(413).json({
      error: { message: tokenBudgetMessage(budgetCheck.rejection), type: 'invalid_request_error', code: 'request_token_budget' },
    });
    return;
  }

  let resolvedChain: ResolvedChain | undefined;
  if (isAutoModel(requestedModel)) {
    resolvedChain = resolveRoutingChain(requestedModel);
  }

  let preferredModel: number | undefined;
  let groupChain: ChainRow[] | undefined;

  if (!isAutoModel(requestedModel) && requestedModel) {
    const db = getDb();
    const resolved = isUnifyEnabled() ? resolveRequestedIdForDispatch(requestedModel, getModelGroups()) : null;
    const members = resolved?.memberDbIds ?? null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members, resolved!.demotedDbIds);
      if (groupChain.length === 0) {
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        // Honest statuses: a model whose providers exist but have no usable key
        // is a server-side configuration gap (503), not a client mistake; a
        // disabled/unknown model is a 404 model_not_found (OpenAI semantics).
        if (anyEnabled) {
          res.status(503).json({
            error: {
              message: `Model '${requestedModel}' has no providers with an enabled key. Add a provider API key for it, use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'service_unavailable',
              code: 'no_providers_configured',
            },
          });
        } else {
          res.status(404).json({
            error: {
              message: `Model '${requestedModel}' is disabled. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          });
        }
        return;
      }
    } else {
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        res.status(404).json({
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
  const attemptLog: AttemptRecord[] = [];
  // Client-disconnect fan-out: the flag stops the loop before the NEXT
  // attempt; the AbortController (threaded to the provider as
  // CompletionOptions.signal) additionally cancels the IN-FLIGHT upstream
  // fetch and any body/stream read, so tokens stop burning and the in-flight
  // lease frees immediately. 'close' also fires on normal completion —
  // writableEnded distinguishes a real disconnect.
  let clientGone = false;
  const clientAbort = new AbortController();
  // Fallback-v2 hedging: the loop aborts this controller (via abortInFlight)
  // when the wall-clock retry budget expires mid-attempt, canceling the
  // in-flight upstream instead of waiting for a stalled attempt to time out.
  const hedgeAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clientAbort.abort(newClientAbortError());
    }
  });

  // Legacy /completions is a thin adapter over the shared fallback loop
  // (lib/fallback-loop.ts): the cooldown/skip/penalty/exhaustion machinery is
  // shared; only the text_completion request/stream translation lives here.
  await runFallbackLoop({
    maxRetries: MAX_RETRIES,
    state,
    attemptLog,
    clientGone: () => clientGone,
    abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
    route: () => routeRequest(
      estimatedTotal,
      state.skipKeys.size > 0 ? state.skipKeys : undefined,
      preferredModel,
      false,
      false,
      state.skipModels.size > 0 ? state.skipModels : undefined,
      groupChain ?? resolvedChain?.chain,
      false,
      state.skipPlatforms.size > 0 ? state.skipPlatforms : undefined,
      outputReserve,
    ),
    dispatch: async (route, attempt, ctx) => {
      traceRouteEvent('Proxy', {
        event: attempt === 0 ? 'start' : 'next',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        requestedModel: attempt === 0 ? requestedModelLabel : undefined,
      });

      // Same GitHub input ceiling as /chat/completions below: trim the
      // dispatched copy so a long legacy prompt doesn't 413 the github hop.
      const dispatchMessages = route.platform === 'github'
        ? truncateMessagesForGithub(messages)
        : messages;

      if (stream) {
        let totalOutputTokens = 0;
        let headerSent = false;
        let ttfbMs: number | null = null;
        let sawText = false;
        let upstreamFinish: string | null = null;
        const buffered: unknown[] = [];

        const flushHeaders = () => {
          if (headerSent) return;
          // #764: ttfb is recorded on the first token of ANY kind (content or
          // reasoning) in the pump loop below; this call only backfills streams
          // that reached the commit point without one.
          if (ttfbMs === null) ttfbMs = Date.now() - start;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
          setFallbackHeaders(res, attempt, attemptLog);
          headerSent = true;
          // Committed: the answer is on its way, so the retry budget must no
          // longer cancel this attempt (it could not fail over now anyway).
          ctx.disarmHedge();
          for (const frame of buffered) res.write(`data: ${JSON.stringify(frame)}\n\n`);
          buffered.length = 0;
        };

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey,
            dispatchMessages,
            route.modelId,
            { temperature, max_tokens, top_p, stop, signal: AbortSignal.any([clientAbort.signal, hedgeAbort.signal]) },
            quotaContextForRoute(route, 'chat/completions'),
          );

          for await (const chunk of gen) {
            if (clientGone) break; // client hung up: stop pulling; reader.cancel() aborts upstream
            const text = streamChunkText(chunk);
            if (text.length > 0) sawText = true;
            // #764: reasoning models stream thinking before any visible text.
            // ttfb must count the first token of ANY kind — otherwise the speed
            // shown is the thinking tail, or NULL when headers never flush.
            const reasoning = streamReasoningText(chunk);
            if (ttfbMs === null && (text.length > 0 || reasoning.length > 0)) {
              ttfbMs = Date.now() - start;
            }
            const finish = (chunk as any)?.choices?.[0]?.finish_reason;
            if (finish) upstreamFinish = finish;
            // #764: reasoning tokens are real output consumption — count them
            // so analytics and the rate-limit ledger aren't undercounted.
            totalOutputTokens += Math.ceil((text.length + reasoning.length) / 4);
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

          // Disconnect before the commit point: the break above fired with no
          // text seen, which is indistinguishable from an empty completion
          // below — but it is CLIENT behavior, not a provider failure. Without
          // this check every Ctrl-C during a reasoning model's TTFB window
          // benched the healthy model+key for 90s and logged a provider error.
          if (clientGone && !headerSent && !sawText) {
            console.log(`[Proxy] client disconnected before first token from ${route.displayName} — dropping attempt without benching`);
            return 'committed';
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
          // Client abort mid-stream: the pump's own `if (clientGone) break`
          // can lose the race against the fetch-signal rejection, so the
          // abort may surface here instead. Rethrow — the shared loop's
          // client-abort branch stops the ladder without benching or an
          // error log row (the socket is gone; nothing to render).
          if (isClientAbortError(streamErr)) throw streamErr;
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
        dispatchMessages,
        route.modelId,
        { temperature, max_tokens, top_p, stop, signal: AbortSignal.any([clientAbort.signal, hedgeAbort.signal]) },
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
      // #809: a bare "safe"/"unsafe" classification word from a relay is an
      // upstream filter, not the requested model — fail over like an empty
      // completion.
      if (isUpstreamClassificationOutput(text, route.platform)) {
        throw Object.assign(
          new Error(`empty completion from ${route.displayName} (upstream classification output)`),
          result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
        );
      }

      // Usage fallback: providers that omit `usage` used to be logged as 0
      // tokens, silently undercounting analytics and the rate-limit ledger.
      // Fall back to the same chars/4 estimate the streaming path uses,
      // including reasoning tokens (thinking models). (#764)
      const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
      const completionTokens = result.usage?.completion_tokens
        ?? Math.ceil((text.length + completionReasoningText(result).length) / 4);
      const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens);
      recordUpstreamSuccess(route, totalTokens);

      res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
      setFallbackHeaders(res, attempt, attemptLog);
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
      setFallbackHeaders(res, attempt, attemptLog);
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`,
          type: 'provider_error',
        },
      });
    },
    onRoutingExhausted: (lastError, routeErr, exhaustion, info) => {
      if (!lastError) {
        // Synchronous exhaustion: the router rejected every candidate before
        // any upstream was tried — log the per-candidate disposition.
        const disposition: string[] = Array.isArray(routeErr.diagnostics) ? routeErr.diagnostics : [];
        console.warn(
          `[Proxy] legacy completions routing exhausted (no upstream tried) req=${shortRequestId(requestGroupId)} ` +
          `requested=${requestedModelLabel} candidates=${disposition.length}` +
          (disposition.length ? `:\n  ${disposition.join('\n  ')}` : ''),
        );
      }
      setFallbackHeaders(res, info.attempts.length, info.attempts);
      setExhaustionHeaders(res, exhaustion);
      res.status(exhaustion.status).json({ error: exhaustionErrorPayload(exhaustion) });
    },
    onExhausted: (exhaustion, info) => {
      setFallbackHeaders(res, info.attempts.length, info.attempts);
      setExhaustionHeaders(res, exhaustion);
      res.status(exhaustion.status).json({ error: exhaustionErrorPayload(exhaustion) });
    },
  });
});

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();
  const requestGroupId = getRequestGroupId(req);
  res.setHeader('X-Request-ID', requestGroupId);

  // Authenticate every proxy request, including loopback callers. Browser
  // pages can reach localhost, so socket locality is not a reliable
  // authorization boundary. Client-profile keys resolve here too, carrying
  // their server-enforced system prompt (#411).
  const auth = requireInferenceAuth(req, res);
  if (!auth) return;

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
  // `max_completion_tokens` is OpenAI's newer alias — honored when max_tokens
  // itself is absent. `let`: the token-budget guardrail below may cap an
  // absent max_tokens to the budget remainder before the options objects are
  // built from it.
  const requestedMaxTokens = parsed.data.max_tokens ?? parsed.data.max_completion_tokens;
  let max_tokens = requestedMaxTokens != null && requestedMaxTokens > 0
    ? requestedMaxTokens : undefined;
  // Extended sampling/output params (seed, penalties, response_format…),
  // spread into every options object below — including fusion fan-out.
  const samplingParams = pickSamplingParams(parsed.data);
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

  let messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
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

  let cacheControlPrefixLength = 0;
  parsed.data.messages.forEach((message, index) => {
    const content = message.content;
    if (
      Array.isArray(content)
      && content.some(block => block && typeof block === 'object' && 'cache_control' in block)
    ) {
      cacheControlPrefixLength = index + 1;
    }
  });
  const compressionResult = compressRequest(messages, {
    header: req.headers['x-freellm-compress'],
    tools,
    cacheControlPrefixLength,
  });
  messages = compressionResult.messages;
  res.setHeader('X-FreeLLM-Compress', formatCompressionHeader(compressionResult));

  // Server-enforced system prompt (#411): injected AFTER compression so it is
  // never compressed away, and FIRST in the list so a caller-supplied system
  // message follows it and cannot override it. Constant per profile, so the
  // provider-side cache prefix stays stable across requests. Neutral no-op for
  // the unified key and for profiles without a prompt.
  messages = prependSystemPrompt(messages, auth.systemPrompt);

  // Downscale over-threshold inline images before estimation/routing so the
  // token budget, payload limits, and upstream transfer all see the shrunk
  // bytes (see lib/image-normalize.ts). Mutates the image blocks in place.
  await normalizeMessageImages(messages);

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block;
  // streaming does the same when stream_options.include_usage produces a final
  // usage frame, and otherwise falls back to this estimate.
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
  // client max_tokens can't starve routing; input + images count in full. The
  // reserve is threaded to the router separately: it is exact and must not be
  // inflated by the context-window safety margin (#956 review).
  const outputReserve = routingReserveTokens(max_tokens);
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + outputReserve;

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

  // Guardrail: per-request token budget (request_max_tokens_budget, default
  // off). Estimated input (incl. images) + requested output must fit the
  // ceiling; a request with no max_tokens gets its output capped to the
  // remainder instead. Sits before the Fusion branch so fan-out inherits the
  // capped max_tokens too.
  const budgetCheck = applyTokenBudget(estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE, max_tokens);
  if (budgetCheck.rejection) {
    res.status(413).json({
      error: { message: tokenBudgetMessage(budgetCheck.rejection), type: 'invalid_request_error', code: 'request_token_budget' },
    });
    return;
  }
  max_tokens = budgetCheck.maxTokens;

  // ── Fusion: multi-model synthesis ──────────────────────────────────────────
  // The virtual "fusion" model fans the prompt out to a panel of diverse models
  // in parallel, then a judge synthesizes one answer. It routes each panel/judge
  // sub-call through the normal path (cooldowns, quotas, analytics), so it
  // behaves like a normal model from the client's side — just K+1x the tokens.
  // Image requests run on vision-capable panel members; tool requests run on
  // tool-capable members and return the first structured tool call directly.
  if (isFusionModel(requestedModel)) {
    const fusionOptions = { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls, ...samplingParams };
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
          vision: hasImage,
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
        vision: hasImage,
      });
      // Structured-output enforcement for fusion (#516 scope gap): the panel/
      // judge output got no format check, so model:"fusion" could hand back
      // prose as a "success" for a json_schema request. Fusion has no failover
      // machinery to hand this to — heal what's healable, otherwise answer
      // honestly instead of pretending. (Streaming fusion stays unenforced,
      // same boundary as every other streamed response.)
      const fusionMsg = (response as any)?.choices?.[0]?.message;
      if (samplingParams.response_format && fusionMsg && !fusionMsg.tool_calls?.length) {
        const fusionText = contentToString(fusionMsg.content ?? '');
        if (fusionText) {
          const enforced = enforceJsonContent(fusionText);
          if (!enforced.ok) {
            res.status(502).json({ error: { message: `fusion produced non-JSON output despite response_format=${samplingParams.response_format.type} — retry, or pin a structured-output-capable model instead of "fusion"`, type: 'server_error' } });
            return;
          }
          if (enforced.healed) fusionMsg.content = enforced.content;
        }
      }
      res.setHeader('X-Routed-Via', safeHeaderValue(routedVia));
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
        // Normalized reasoning knob (flat field or object form) — a different
        // effort asks for a different answer, so it must never collide.
        reasoning_effort: samplingParams.reasoning_effort ?? undefined,
        compression: compressionResult.cacheKey,
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

  // ── Idempotency-Key (services/idempotency.ts) ──
  // Optional caller-scoped dedup for NON-streaming requests: a client that
  // times out and retries with the same Idempotency-Key gets the ORIGINAL
  // response replayed (zero provider cost) instead of burning a second
  // free-tier slot. Only a SHA-256 hash of the key is stored. Reusing a key
  // with different request content is a 409 conflict. Streaming always
  // bypasses (like the response cache) — a stream cannot be replayed as a
  // unit, and the open connection is itself the retry signal.
  const idemKeyRaw = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
  const idemKey = !stream ? normalizeIdempotencyKey(idemKeyRaw) : null;
  const idemFingerprint = idemKey
    ? computeIdempotencyFingerprint({
        model: requestedModel,
        messages,
        temperature,
        top_p,
        max_tokens,
        tools,
        tool_choice,
      })
    : null;
  if (idemKey && idemFingerprint) {
    const keyHash = hashIdempotencyKey(idemKey);
    const claim = lookupIdempotencyReplay(keyHash, idemFingerprint);
    if (claim.kind === 'replay') {
      // Replay consumes NO provider quota — same zero-cost rationale as a
      // cache hit, so request/usage bookkeeping is skipped here too.
      res.setHeader('X-Routed-Via', 'idempotency');
      res.status(claim.status).json(claim.body);
      return;
    }
    if (claim.kind === 'conflict') {
      res.status(409).json({
        error: {
          message: 'idempotency_key_conflict',
          type: 'invalid_request_error',
        },
      });
      return;
    }
    // kind === 'miss': no prior claim (or it expired) — proceed normally
    // and persist the result on success below.
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

  // #797: key for the per-session thinking-trace memory. Read and written
  // inside the dispatch loop, where the routed platform/model is known — the
  // restore only ever touches the OUTBOUND copy, never `messages`, so handoff
  // recording above, request logging, compression and the response cache all
  // keep seeing exactly what the client sent.
  //
  // Header-less clients are covered: without x-session-id, getSessionKey hashes
  // the FIRST user message, which does not change as the conversation grows —
  // the same stability sticky sessions already rely on. Its known weakness is
  // shared here: two conversations opening with identical text share a key, so
  // the same-model + field-actually-missing gates below are what keep a
  // mis-keyed restore from reaching a payload it does not belong in.
  const reasoningSessionKey = getSessionKey(messages, sessionIdHeader, strategyKey);
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
    preferredModel = resolveStickyPreference(getStickyModel(messages, sessionIdHeader, strategyKey), resolvedChain?.chain);
  } else if (requestedModel) {
    const db = getDb();
    // Unify ON: a requested id (canonical slug OR any provider's model_id) maps
    // to the whole logical-model group, and we route STRICTLY across only its
    // providers — failing over between them, never to a different model (#335).
    const resolved = isUnifyEnabled() ? resolveRequestedIdForDispatch(requestedModel, getModelGroups()) : null;
    const members = resolved?.memberDbIds ?? null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members, resolved!.demotedDbIds);
      if (groupChain.length === 0) {
        // Distinguish a catalog-disabled model (404 model_not_found, OpenAI
        // semantics) from one whose providers are present but unusable
        // (chain-disabled / no key) — the latter is a server-side
        // configuration gap, so it renders an honest 503.
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        if (anyEnabled) {
          res.status(503).json({
            error: {
              message: `Model '${requestedModel}' has no providers with an enabled key. Add a provider API key for it, use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'service_unavailable',
              code: 'no_providers_configured',
            },
          });
        } else {
          res.status(404).json({
            error: {
              message: `Model '${requestedModel}' is disabled. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          });
        }
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
        res.status(404).json({
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
    preferredModel = resolveStickyPreference(getStickyModel(messages, sessionIdHeader, strategyKey), resolvedChain?.chain);
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
  const attemptLog: AttemptRecord[] = [];
  // Client-disconnect fan-out: the flag stops the loop before the NEXT
  // attempt; the AbortController (threaded to the provider as
  // CompletionOptions.signal) additionally cancels the IN-FLIGHT upstream
  // fetch and any body/stream read, so tokens stop burning and the in-flight
  // lease frees immediately. 'close' also fires on normal completion —
  // writableEnded distinguishes a real disconnect.
  let clientGone = false;
  const clientAbort = new AbortController();
  // Fallback-v2 hedging: the loop aborts this controller (via abortInFlight)
  // when the wall-clock retry budget expires mid-attempt, canceling the
  // in-flight upstream instead of waiting for a stalled attempt to time out.
  const hedgeAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clientAbort.abort(newClientAbortError());
    }
  });

  await runFallbackLoop({
    maxRetries: MAX_RETRIES,
    state,
    attemptLog,
    clientGone: () => clientGone,
    abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
    route: () => {
      // When a handoff could fire this turn, pad the token estimate so the router's
      // context-window and TPM checks account for the extra system message overhead.
      // We don't know the selected model key until after routeRequest() returns, so
      // the padding is conservative on turns where injection is *possible* (a prior
      // model is on record). Turns where injection can't happen — every turn 1, and
      // sessions that never switched — pay no headroom tax.
      const routingEstimate = handoffPossible ? estimatedTotal + HANDOFF_MAX_TOKENS : estimatedTotal;
      return routeRequest(routingEstimate, state.skipKeys.size > 0 ? state.skipKeys : undefined, preferredModel, hasImage, wantsTools, state.skipModels.size > 0 ? state.skipModels : undefined, groupChain ?? resolvedChain?.chain, samplingParams.response_format !== undefined, state.skipPlatforms.size > 0 ? state.skipPlatforms : undefined, outputReserve);
    },
    dispatch: async (route, attempt, ctx) => {
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
    // #797: thinking trace accumulated from this turn's streamed deltas, then
    // remembered per-session so a follow-up whose client stripped the field
    // can have it restored (see restore block above).
    let streamReasoning = '';
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

    // #797: restore the thinking trace this proxy emitted last turn, for THIS
    // model, when the client dropped it on replay. Scoped to the outbound copy
    // and to the model that produced the trace, so a failover hop and every
    // provider that never needed the field send the client's bytes unchanged.
    const rememberedReasoning = rememberedReasoningFor(reasoningSessionKey, modelKey);
    if (rememberedReasoning) {
      outboundMessages = restoreSessionReasoning(outboundMessages, rememberedReasoning, route.platform);
    }

    // GitHub Models 413s a history above its input ceiling instead of
    // truncating it, so a long conversation burns the github hop of every
    // chain it appears in. Trim the outbound copy to what the platform will
    // accept — scoped to this attempt, so the next candidate still sees the
    // client's full history. A no-op returning the same array when the
    // request already fits.
    if (route.platform === 'github') {
      outboundMessages = truncateMessagesForGithub(outboundMessages);
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
        // Raw upstream-reported model, captured off the first frame that
        // carries one — BEFORE the per-frame overwrite below destroys it.
        // Only evidence when a provider serves a different model than routed
        // (#534); compared/persisted on success via observeServedModel.
        let upstreamModel: string | null = null;

        const flushHeaders = () => {
          if (headerSent) return;
          // #764: backfill only — the pump loop already records ttfb on the
          // first token (content or reasoning) it sees.
          if (ttfbMs === null) ttfbMs = Date.now() - start;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
          setFallbackHeaders(res, attempt, attemptLog);
          headerSent = true;
          // Committed: the answer is on its way, so the retry budget must no
          // longer cancel this attempt (it could not fail over now anyway).
          ctx.disarmHedge();
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
            { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls, stream_options: parsed.data.stream_options, ...samplingParams, signal: AbortSignal.any([clientAbort.signal, hedgeAbort.signal]) },
            quotaContextForRoute(route, 'chat/completions'),
          );

          for await (const chunk of gen) {
            if (clientGone) break; // client hung up: stop pulling; reader.cancel() aborts upstream
            // Provider metadata is not authoritative for the public gateway
            // response. Some OpenAI-compatible providers (notably Reka) return
            // the literal model name "default" even when a concrete model was
            // requested. Normalize every streamed frame at the proxy boundary
            // so clients consistently see the model that was actually routed.
            const rawChunkModel = (chunk as Record<string, any>).model;
            if (upstreamModel == null && typeof rawChunkModel === 'string' && rawChunkModel.length > 0) {
              upstreamModel = rawChunkModel;
            }
            const anyChunk: Record<string, any> = { ...(chunk as Record<string, any>), model: route.modelId };

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

            // Usage arrives either on its own frame (OpenAI's
            // stream_options.include_usage shape) or bundled onto the last
            // choice-bearing frame — several providers do the latter, and
            // reading it only off choice-less frames threw their real token
            // counts away and left accounting on the chars/4 estimate. Capture
            // it wherever it lands, reduced to a usage-only frame: the frame's
            // deltas are re-emitted through our own framing below, so holding
            // the original verbatim would duplicate content (or a finish_reason
            // the client already saw) when it is written back after our finish
            // chunk to preserve OpenAI ordering.
            if (anyChunk.usage) usageChunk = { ...anyChunk, choices: [], usage: anyChunk.usage };

            const choice = anyChunk.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) upstreamFinish = choice.finish_reason;

            // #797: accumulate this turn's thinking trace (native reasoning
            // deltas; the <think> extractor in base.ts has already normalized
            // inline tags into reasoning_content) so a follow-up request whose
            // client stripped it can have it restored from session memory.
            // Shared with the #764 ttfb/token accounting below.
            const reasoning = streamReasoningText(anyChunk);
            if (reasoning.length > 0) streamReasoning += reasoning;

            // Buffer tool_call deltas — emitted complete + repaired at end.
            for (const tc of choice.delta?.tool_calls ?? []) {
              const idx = tc.index ?? 0;
              if (!toolCallAcc.has(idx)) toolCallAcc.set(idx, { id: undefined, name: '', args: '' });
              const acc = toolCallAcc.get(idx)!;
              if (tc.id && !acc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }

            normalizeOutboundContent(anyChunk);
            sanitizeResponse(anyChunk);
            const text = typeof choice.delta?.content === 'string' ? choice.delta.content : '';

            // #764: ttfb = first token of ANY kind, not just visible content —
            // reasoning models stream thinking long before the first answer
            // token, and the old code deferred ttfb until header flush (or left
            // it NULL on long-thinking turns that never flushed).
            if (ttfbMs === null && (text.length > 0 || reasoning.length > 0)) {
              ttfbMs = Date.now() - start;
            }

            if (text.length === 0) {
              // Role preamble / keep-alive: hold until first payload decides
              // the mode, forward afterwards. tool_calls and finish_reason are
              // stripped — both are re-emitted complete at the end (OpenRouter
              // attaches tool_call deltas to chunks that also carry role/
              // reasoning keys; forwarding them raw would duplicate the call).
              // #764: thinking-only chunks still consumed tokens — count them.
              if (reasoning.length > 0) totalOutputTokens += Math.ceil(reasoning.length / 4);
              if (choice.delta && Object.keys(choice.delta).some(k => k !== 'content' && k !== 'tool_calls' && choice.delta[k] != null)) {
                // `usage: undefined` (dropped by JSON.stringify): it was held
                // above and is re-emitted once, after our finish chunk.
                const cleaned = { ...anyChunk, usage: undefined, choices: [{ ...choice, delta: { ...choice.delta, tool_calls: undefined }, finish_reason: null }] };
                if (headerSent) writeChunk(cleaned); else preamble.push(cleaned);
              }
              continue;
            }

            // #764: count reasoning tokens with the same chars/4 estimate so
            // analytics and rate-limit reflect real consumption of thinking
            // models (a chunk can carry both reasoning and text).
            totalOutputTokens += Math.ceil((text.length + reasoning.length) / 4);

            if (mode === 'passthrough') {
              // Same rule as the preamble path: usage rides the held frame,
              // not this one, so the client sees it exactly once and last.
              writeChunk({ ...anyChunk, usage: undefined, choices: [{ ...choice, delta: { ...choice.delta, tool_calls: undefined }, finish_reason: null }] });
              continue;
            }

            heldText += text;
            if (mode === 'dialect') continue;

            const probe = heldText.trimStart();
            if (wantsTools && startsWithDialectMarker(probe)) {
              mode = 'dialect';
            } else if (!wantsTools || !couldBecomeDialectMarker(probe) || probe.length > 256) {
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
          if (wantsTools && (mode === 'dialect' || (mode === 'undecided' && heldText.length > 0 && containsDialectMarker(heldText)))) {
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

          // Opt-in schema verdict, taken AFTER the rescue so it covers the
          // calls the rescue reconstructed from prose — those are the ones
          // most likely to be malformed, and running first exempted exactly
          // them. `!headerSent` is the whole licence to throw here: the commit
          // point is held until the first meaningful content, so the common
          // tool-call turn (no prose before the call) has sent no bytes yet and
          // can still fail over invisibly. A turn that already flushed prose is
          // past the point of no return — the catch below would have to tear
          // the SSE stream down with a `stream_error`, which is strictly worse
          // for the client than forwarding a tool call the schema dislikes.
          // Off-by-default or not, this check must never turn a served answer
          // into a broken one.
          if (isToolArgumentValidationEnabled() && !headerSent && completedCalls.length > 0) {
            const invalid = invalidToolCallReasons(completedCalls, schemas);
            if (invalid.length > 0) throw invalidToolArgumentsError(route.displayName, invalid);
          }

          // Disconnect before the commit point: nothing usable was (or will
          // be) delivered, and that is CLIENT behavior, not a provider
          // failure — do not let it fall through to the empty-completion
          // throw below, which would bench a healthy model+key for 90s and
          // log a provider error for every Ctrl-C during a reasoning model's
          // TTFB window.
          if (clientGone && !headerSent && heldText.trim().length === 0 && completedCalls.length === 0) {
            console.log(`[Proxy] client disconnected before first token from ${route.displayName} — dropping attempt without benching`);
            return 'committed';
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
          // #809: a bare "safe"/"unsafe" classification word streamed by a
          // relay is an upstream filter, not the requested model — fail over
          // like an empty completion.
          if (isUpstreamClassificationOutput(heldText, route.platform) && completedCalls.length === 0) {
            throw Object.assign(
              new Error(`empty completion from ${route.displayName} (upstream classification output)`),
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
          // One prompt-token estimate for both the injected usage frame below
          // and the accounting fallback after it, so a client that reads the
          // frame and the row this request writes can never disagree. Images
          // are billed at the same flat per-image estimate the routing budget
          // uses (the chars/4 pass sees text only).
          const estimatedPromptTokens = estimatedInputTokens + injectedHandoffTokens + imageCount * IMAGE_TOKEN_ESTIMATE;
          if (usageChunk) {
            writeChunk(usageChunk);
          } else if (parsed.data.stream_options?.include_usage) {
            // Some OpenAI-compatible upstreams (e.g. OpenCode Zen) never echo
            // a final usage frame even when stream_options.include_usage is
            // requested. Strict clients (Hermes, Cline, Continue) treat a
            // missing usage block as "no accounting happened" and skip
            // per-call token/cost/billing_provider writes entirely.
            //
            // Injected ONLY when the client asked for usage via
            // stream_options.include_usage AND the upstream never sent one;
            // the numbers are this gateway's own chars/4 estimate (the same
            // total the accounting below records), never the upstream's
            // accounting, so the block is flagged `estimated: true` rather
            // than passed off as real counts.
            const completionTokens = totalOutputTokens;
            writeChunk({
              id: lastMeta.id ?? `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: lastMeta.created ?? Math.floor(Date.now() / 1000),
              model: lastMeta.model ?? route.modelId,
              choices: [],
              usage: {
                prompt_tokens: estimatedPromptTokens,
                completion_tokens: completionTokens,
                total_tokens: estimatedPromptTokens + completionTokens,
                estimated: true,
              },
            });
          }
          res.write('data: [DONE]\n\n');
          res.end();

          const upstreamUsage = (usageChunk as { usage?: TokenUsage } | null)?.usage;
          const inputTokens = upstreamUsage?.prompt_tokens ?? estimatedPromptTokens;
          const outputTokens = upstreamUsage?.completion_tokens ?? totalOutputTokens;
          const totalTokens = upstreamUsage?.total_tokens ?? (inputTokens + outputTokens);
          recordUpstreamSuccess(route, totalTokens);
          setStickyModel(messages, route.modelDbId, sessionIdHeader, stickyStrategyKey);
          if (handoffMode !== 'off' && sessionKey) recordSuccessfulModel({ sessionKey, modelKey });
          // #797: remember this turn's thinking trace so the next request from
          // the same session can restore it (clients strip it on replay).
          if (streamReasoning.length > 0) rememberReasoning(reasoningSessionKey, modelKey, streamReasoning);
          traceRouteEvent('Proxy', {
            event: 'ok',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            inputTokens,
            outputTokens,
          });
          logRequest(route.platform, route.modelId, route.keyId, 'success', inputTokens, outputTokens, Date.now() - start, null, ttfbMs, pinnedModelId,
            observeServedModel({ platform: route.platform, requestedModel: route.modelId, servedModel: upstreamModel }));
          return 'done';
        } catch (streamErr: any) {
          // Client abort mid-stream: the pump's own `if (clientGone) break`
          // can lose the race against the fetch-signal rejection, so the
          // abort may surface here instead. Rethrow — the shared loop's
          // client-abort branch stops the ladder without benching or an
          // error log row (the socket is gone; nothing to render).
          if (isClientAbortError(streamErr)) throw streamErr;
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
          { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls, ...samplingParams, signal: AbortSignal.any([clientAbort.signal, hedgeAbort.signal]) },
          quotaContextForRoute(route, 'chat/completions'),
        );

        // Raw upstream-reported model, captured BEFORE the contract overwrite
        // below destroys it — the only evidence when a provider silently
        // serves a different model than requested (#534). The OpenAI-compat,
        // cohere, and cloudflare adapters pass the upstream body through, so
        // result.model here is still the provider's own claim; google/aihorde
        // synthesize their responses with the routed id (no upstream signal).
        const upstreamModel = typeof result.model === 'string' ? result.model : null;

        // Upstream `model` fields are provider-controlled and can be a generic
        // placeholder such as Reka's "default". The gateway contract exposes
        // the concrete routed model, consistently across every provider.
        result.model = route.modelId;

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
        // #809: a bare "safe"/"unsafe" classification word from a relay is an
        // upstream filter, not the requested model — fail over like an empty
        // completion.
        if (isUpstreamClassificationOutput(respText, route.platform) && (respMsg?.tool_calls?.length ?? 0) === 0) {
          throw Object.assign(
            new Error(`empty completion from ${route.displayName} (upstream classification output)`),
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

        // Structured-output enforcement (#514 follow-up): the client asked for
        // JSON; a model that answered in prose despite the forwarded
        // response_format must not be returned as a "success". Heal the common
        // almost-right shapes (fenced block, prose-wrapped JSON) in place;
        // otherwise fail over. Deliberately AFTER the dialect rescue (matching
        // responses.ts): an inline tool-call turn isn't JSON either, and
        // gating it first burned a failover hop on turns the rescue converts.
        // skipBench: the provider is healthy — the MODEL misbehaved — so no
        // cooldown/penalty; skipModelForRequest: a sibling key would misbehave
        // identically, so rule out the whole model for this request.
        if (samplingParams.response_format && respText && (respMsg?.tool_calls?.length ?? 0) === 0) {
          const enforced = enforceJsonContent(respText);
          if (!enforced.ok) {
            // finish_reason 'length' = the JSON was CUT OFF by max_tokens, not
            // ignored — same failover (a terser model may fit the budget), but
            // an honest error class/trail instead of "ignored response_format".
            const truncated = result.choices?.[0]?.finish_reason === 'length';
            throw Object.assign(
              new Error(truncated
                ? `truncated JSON from ${route.displayName} (finish_reason=length — raise max_tokens for this ${samplingParams.response_format.type} request)`
                : `${route.displayName} ignored response_format (returned non-JSON despite ${samplingParams.response_format.type})`),
              { skipBench: true, skipModelForRequest: true },
            );
          }
          if (enforced.healed && respMsg) {
            respMsg.content = enforced.content;
          }
        }

        // Repair double-encoded tool arguments against the request's tool
        // schemas (e.g. GLM emitting an array parameter as a JSON string),
        // so strict clients don't reject the call. Schema-gated — a true
        // string parameter is never touched. See lib/tool-args.ts.
        //
        // Deliberately BEFORE the success bookkeeping below: the opt-in schema
        // verdict that follows can still fail this attempt over, and crediting
        // recordUpstreamSuccess / rememberReasoning / setStickyModel to an
        // attempt we are about to discard would bill a model that never served
        // the turn and pin the session to it for the next one.
        if (respMsg?.tool_calls?.length) {
          const schemas = toolSchemaMap(tools);
          for (const tc of respMsg.tool_calls) {
            if (tc?.function?.arguments != null) {
              tc.function.arguments = repairToolArguments(tc.function.arguments, schemas.get(tc.function.name));
            }
          }
          // Whatever the repair could not fix is still broken. Opt-in, and
          // thrown before anything is written, so failover is invisible.
          if (isToolArgumentValidationEnabled()) {
            const invalid = invalidToolCallReasons(respMsg.tool_calls, schemas);
            if (invalid.length > 0) throw invalidToolArgumentsError(route.displayName, invalid);
          }
        }

        // Usage fallback: providers that omit `usage` used to be logged as 0
        // tokens, silently undercounting analytics and the rate-limit ledger.
        // Fall back to the same chars/4 estimate the streaming path uses (tool
        // arguments included, mirroring the stream accounting; counted after
        // the repair above, so it measures the bytes actually sent, and
        // reasoning tokens included too, so thinking models aren't
        // undercounted — #764).
        const respToolArgChars = (respMsg?.tool_calls ?? []).reduce((n, tc) => n + (tc?.function?.arguments?.length ?? 0), 0);
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens
          ?? Math.ceil((contentToString(respMsg?.content ?? '').length + completionReasoningText(result).length + respToolArgChars) / 4);
        const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens);
        recordUpstreamSuccess(route, totalTokens);
        // #797: remember this turn's thinking trace so the next request from
        // the same session can restore it (clients strip it on replay).
        // normalizeChoices keeps reasoning_content on the message even when it
        // folds the trace into an otherwise-empty content field.
        if (typeof respMsg?.reasoning_content === 'string' && respMsg.reasoning_content.length > 0) {
          rememberReasoning(reasoningSessionKey, modelKey, respMsg.reasoning_content);
        }
        // Use stickyStrategyKey (not the global strategyKey) so a group-pinned
        // request writes its sticky entry under the SAME key the next turn reads
        // from (set to the requested model id at the top of the loop). Matches the
        // streaming success path; without it, "prefer last successful provider"
        // is lost for non-streaming group-pinned sessions. (#341 review)
        setStickyModel(messages, route.modelDbId, sessionIdHeader, stickyStrategyKey);
        if (handoffMode !== 'off' && sessionKey) recordSuccessfulModel({ sessionKey, modelKey });

        res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
        setFallbackHeaders(res, attempt, attemptLog);
        // Normalize array-shaped message.content to a string on the way out (#166).
        const outboundBody = sanitizeResponse(normalizeOutboundContent(result));
        res.setHeader('X-FreeLLM-Cache', cacheKey ? 'MISS' : 'OFF');

        // Persist the completed response for Idempotency-Key replays. Only
        // non-streaming requests with a valid key reach here; a truncated turn
        // (finish_reason 'length') is NOT stored — replaying a cut-off answer
        // would be worse than regenerating, matching the cache policy below.
        if (
          idemKey
          && idemFingerprint
          && result.choices?.[0]?.finish_reason !== 'length'
        ) {
          storeIdempotencyResult(
            hashIdempotencyKey(idemKey),
            idemFingerprint,
            200,
            outboundBody,
            requestGroupId,
          );
        }

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
        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null, null, pinnedModelId,
          observeServedModel({ platform: route.platform, requestedModel: route.modelId, servedModel: upstreamModel }));
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
      setFallbackHeaders(res, attempt, attemptLog);
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`,
          type: 'provider_error',
        },
      });
    },
    onRoutingExhausted: (lastError, routeErr, exhaustion, info) => {
      // No more models available.
      if (!lastError) {
        // Synchronous exhaustion: the router rejected every candidate before any
        // upstream was tried, so this is the ONLY place the per-model disposition
        // is recorded. Without it the exhaustion status is opaque — you can't tell
        // a genuinely dry pool from cooldowns/quota/context narrowing (issue _1).
        const disposition: string[] = Array.isArray(routeErr.diagnostics) ? routeErr.diagnostics : [];
        console.warn(
          `[Proxy] routing exhausted (no upstream tried) req=${shortRequestId(requestGroupId)} ` +
          `requested=${requestedModelLabel} candidates=${disposition.length}` +
          (disposition.length ? `:\n  ${disposition.join('\n  ')}` : ''),
        );
      }
      setFallbackHeaders(res, info.attempts.length, info.attempts);
      setExhaustionHeaders(res, exhaustion);
      res.status(exhaustion.status).json({ error: exhaustionErrorPayload(exhaustion) });
    },
    onExhausted: (exhaustion, info) => {
      setFallbackHeaders(res, info.attempts.length, info.attempts);
      setExhaustionHeaders(res, exhaustion);
      res.status(exhaustion.status).json({ error: exhaustionErrorPayload(exhaustion) });
    },
  });
});

// logRequest moved to lib/request-log.ts (shared with the fusion service to
// avoid an import cycle); imported above for internal use and re-exported here
// for routes/responses.ts which imports it from this module.
export { logRequest };
