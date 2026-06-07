import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, ModelListRow } from '@freellmapi/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, hasEnabledVisionModel, hasEnabledToolsModel, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit, PAYMENT_REQUIRED_COOLDOWN_MS } from '../services/ratelimit.js';
import { pruneRequestAnalytics } from '../services/request-retention.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { contentToString, messageHasImage, normalizeOutboundContent } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';

export const proxyRouter = Router();

// Virtual "auto" model. Clients like Hermes require a non-empty `model` field
// on every request, but freellmapi's whole point is to pick the model itself.
// Requesting this id means "let the router decide" — identical to omitting
// `model` entirely.
const AUTO_MODEL_ID = 'auto';

function isAutoModel(modelId: string | undefined): boolean {
  return modelId === AUTO_MODEL_ID;
}

// Constant-time string comparison for the unified API key. Plain `===` leaks
// length and per-character timing, which a network attacker could in principle
// use to recover the key one byte at a time.
export function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare against a same-length buffer regardless of input length so the
  // comparison itself runs in constant time; the explicit length check at the
  // end is what actually decides equality when lengths differ.
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
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

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(messages: ChatMessage[], sessionIdHeader?: string): string {
  // Explicit session pinning: clients that manage their own conversation ids
  // (agent harnesses especially) can send X-Session-Id and get exact
  // affinity regardless of how their message history mutates. (#231)
  if (sessionIdHeader) return `hdr:${sessionIdHeader}`;

  // Otherwise the first user message identifies the session — clients re-send
  // the full conversation each turn, so it is stable across turns. Flatten
  // array-of-blocks content before hashing: opencode-style agents send
  // [{type:'text',...}] even for plain text, and the old string-only check
  // silently disabled stickiness for them, re-routing every turn (#231 audit:
  // observed a rank-2 → rank-11 mid-conversation flip). No turn-count suffix:
  // the old ':single'/':multi' split guaranteed a sticky MISS on turn 2,
  // exactly where agents replay the assistant's tool-call dialect and a model
  // switch causes cross-dialect contamination.
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const text = contentToString(firstUser.content ?? '');
  if (!text) return '';
  return crypto.createHash('sha1').update(text).digest('hex');
}

export function getStickyModel(messages: ChatMessage[], sessionIdHeader?: string): number | undefined {
  // Only apply sticky for multi-turn (has assistant messages = continuation)
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages, sessionIdHeader);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

export function setStickyModel(messages: ChatMessage[], modelDbId: number, sessionIdHeader?: string) {
  const key = getSessionKey(messages, sessionIdHeader);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
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

  const db = getDb();
  const models = db.prepare(`
    SELECT platform, model_id, display_name, context_window
    FROM (
      SELECT platform, model_id, display_name, context_window, intelligence_rank, id,
             ROW_NUMBER() OVER (
               PARTITION BY model_id
               ORDER BY intelligence_rank ASC, id ASC
             ) AS rn
      FROM models m
      WHERE m.enabled = 1
        AND EXISTS (
          SELECT 1 FROM api_keys k
          WHERE k.platform = m.platform
            AND k.enabled = 1
            AND (m.key_id IS NULL OR k.id = m.key_id)
        )
    )
    WHERE rn = 1
    ORDER BY intelligence_rank ASC, id ASC
  `).all() as ModelListRow[];

  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Auto (router picks the best available model)',
        context_window: null,
      },
      ...models.map(m => ({
        id: m.model_id,
        object: 'model',
        created: 0,
        owned_by: m.platform,
        name: m.display_name,
        context_window: m.context_window,
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
  stream: z.boolean().optional(),
  // Top-level tool knobs may arrive as explicit nulls from clients that
  // serialize every field of their request struct; all treated as absent
  // and never forwarded as null. (#200)
  tools: z.array(toolDefinitionSchema).nullable().optional(),
  tool_choice: toolChoiceSchema.nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
});

export function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    // 413: this model's payload limit is too small for the request, but another
    // provider in the fallback chain may have a larger limit. Same reasoning as 503.
    || msg.includes('413') || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
    // 404: model deprecated/removed upstream (e.g. OpenRouter's "no endpoints found"
    // for a model that's been pulled). Rotate to the next model in the chain —
    // setCooldown + the health checker will avoid this model on subsequent requests.
    || msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    // 400: one provider may reject parameters another accepts (e.g. max_tokens
    // limits, unsupported params). The matching pattern is "api error 400"
    // which comes from the OpenAI-compat provider's error formatting, not
    // a bare "400" which is deliberately non-retryable for validation errors.
    || msg.includes('api error 400')
    // 402: this provider/key is out of credits (e.g. HuggingFace Router
    // "API error 402: Payment required"). The SAME model often lives on another
    // provider (Kimi K2.6 is on HF + Cloudflare + NVIDIA), so fail over instead
    // of killing the workflow. Paired with a long cooldown (isPaymentRequiredError)
    // so we don't re-hammer the broke key every retry.
    || isPaymentRequiredError(err)
    // Dead-turn classes from the stream turn-integrity layer (#231 audit):
    // all thrown before any byte reached the client, so another model can
    // serve the request invisibly.
    || msg.includes('empty completion')
    || msg.includes('in-band provider error')
    || msg.includes('stream ended unexpectedly')
    || msg.includes('stream stalled')
    || msg.includes('unparseable inline tool-call dialect');
}

// A 402 Payment Required / out-of-credits error. Distinct from a transient 429:
// it won't recover on the next window, so the caller benches the model+key with
// PAYMENT_REQUIRED_COOLDOWN_MS (a full day) rather than the 90s transient cooldown.
export function isPaymentRequiredError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('402') || msg.includes('payment required')
    || msg.includes('insufficient_quota') || msg.includes('insufficient credit')
    || msg.includes('insufficient balance');
}

// A 404 "model removed/deprecated upstream" error. It's a MODEL-level failure,
// not a key-level one: every key for the platform will 404 the same way, so the
// retry loop skips the entire model for the rest of the request instead of
// burning one fallback attempt per key on the same dead route.
// (PR #111, credits @barbotkonv.)
export function isModelNotFoundError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found');
}

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
    const result = await runEmbeddings(parsed.data.model, inputs);
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

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();

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
  // Agent-tolerant knob normalization (#200): max_tokens <= 0 means "no
  // limit" in several clients → unset; tool_choice 'any' is OpenAI's
  // 'required'; tool definitions get their 'function' type re-defaulted.
  const max_tokens = parsed.data.max_tokens != null && parsed.data.max_tokens > 0
    ? parsed.data.max_tokens : undefined;
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
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + (max_tokens ?? 1000);

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

  // Optional client-managed session affinity (see getSessionKey). Express
  // lower-cases header names; a repeated header arrives as an array — take
  // the first value.
  const rawSessionId = req.headers['x-session-id'];
  const sessionIdHeader = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

  // Explicit `model` field pins routing. If the catalog has no enabled row
  // matching the requested id, return 400 — silently auto-routing to a
  // different model would be surprising to OpenAI-compatible clients.
  // Sticky-session is the fallback when no `model` field was sent at all.
  let preferredModel: number | undefined;
  if (isAutoModel(requestedModel)) {
    // Explicit "auto" → behave exactly like an omitted model field.
    preferredModel = getStickyModel(messages, sessionIdHeader);
  } else if (requestedModel) {
    const db = getDb();
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
  } else {
    preferredModel = getStickyModel(messages, sessionIdHeader);
  }

  // For analytics: the model id the client pinned, null when auto-routed
  // ('auto' or omitted). Logged with every request row so pinned vs auto
  // traffic and failover overrides are visible.
  const pinnedModelId = requestedModel && !isAutoModel(requestedModel) ? requestedModel : null;

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, hasImage, wantsTools, skipModels.size > 0 ? skipModels : undefined);
    } catch (err: any) {
      // No more models available
      if (lastError) {
        const safeLastError = sanitizeProviderErrorMessage(lastError.message);
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${safeLastError}`,
            type: 'rate_limit_error',
          },
        });
      } else {
        res.status(err.status ?? 503).json({
          error: { message: err.message, type: 'routing_error' },
        });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
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
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
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
              logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, `in-band error frame: ${sanitizeProviderErrorMessage(String(msg))}`, ttfbMs, pinnedModelId);
              return;
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
            } else if (!couldBecomeDialectMarker(probe) || heldText.length > 256) {
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
            throw new Error(`empty completion from ${route.displayName} (stream produced no content and no tool calls)`);
          }

          flushHeaders();
          if (heldText.length > 0) {
            writeChunk(mkChunk({ content: heldText }, null));
            totalOutputTokens += Math.ceil(heldText.length / 4);
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

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId, sessionIdHeader);
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, ttfbMs, pinnedModelId);
          return;
        } catch (streamErr: any) {
          if (headerSent) {
            // Mid-stream error after real payload reached the client — finish
            // the SSE response honestly instead of leaving the client hanging.
            console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message), null, pinnedModelId);
            return;
          }
          // Headers never sent — bubble to the outer retry handler, which
          // cooldowns this model+key and tries the next one. Covers upstream
          // HTTP errors, in-band error frames, abrupt EOF, stalls, empty
          // completions, and unparseable dialect turns alike.
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
        );

        // Empty completion (no text, no tool calls) → fail over rather than
        // return a transport-level "success" the caller can't act on. Mirrors
        // the zero-chunk streaming case above.
        const respMsg = result.choices?.[0]?.message;
        const respText = contentToString(respMsg?.content ?? '');
        if (!respText && (respMsg?.tool_calls?.length ?? 0) === 0) {
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)', null, pinnedModelId);
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
          recordRateLimitHit(route.modelDbId);
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
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

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId, sessionIdHeader);

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
        res.json(normalizeOutboundContent(result));

        logRequest(
          route.platform, route.modelId, route.keyId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, null, null, pinnedModelId,
        );
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, null, pinnedModelId);

      if (isRetryableError(err)) {
        // Model-level 404 (removed/deprecated upstream): rule the whole model
        // out for the rest of this request — its other keys would 404 the same
        // way. The per-key cooldown below still applies, so cross-request
        // behavior (#66/#76) is unchanged. (PR #111, credits @barbotkonv.)
        if (isModelNotFoundError(err)) skipModels.add(route.modelDbId);

        // Put this model+key on cooldown and try the next one
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        setCooldown(
          route.platform,
          route.modelId,
          route.keyId,
          isPaymentRequiredError(err)
            ? PAYMENT_REQUIRED_COOLDOWN_MS
            : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, {
                rpd: route.rpdLimit,
                tpd: route.tpdLimit,
              }),
        );
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Proxy] ${safeError.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Non-retryable error (auth, 4xx, etc.): don't retry
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${safeError}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  // Exhausted all retries
  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${sanitizeProviderErrorMessage(lastError?.message)}`,
      type: 'rate_limit_error',
    },
  });
});

export function logRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  ttfbMs: number | null = null,
  // The model id the client pinned; null for auto-routed requests. Lets
  // analytics split pinned vs auto traffic and detect failover overrides
  // (requested_model set but != model_id).
  requestedModel: string | null = null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error, ttfbMs, requestedModel);
    pruneRequestAnalytics({ db });
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
