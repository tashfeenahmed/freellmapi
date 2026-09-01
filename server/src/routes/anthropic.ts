import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  ChatContentBlock,
} from '@freellmapi/shared/types.js';
import { routeRequest, resolveModelGroupCandidates, resolveStickyPreference, routingReserveTokens, type RouteResult, type ChainRow } from '../services/router.js';
import { getSetting, getUnifiedApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { invalidToolArgumentsError, invalidToolCallReasons, isToolArgumentValidationEnabled } from '../lib/tool-validate.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { convertDocumentBlock, documentRejectionMessage } from '../lib/anthropic-documents.js';
import { isClientAbortError, newClientAbortError, newHedgeAbortError, isUpstreamClassificationOutput } from '../lib/error-classify.js';
import { logRequest } from '../lib/request-log.js';
import { extractApiToken, timingSafeStringEqual, getStickyModel, setStickyModel } from './proxy.js';
import { runFallbackLoop, newFallbackState, recordUpstreamSuccess, type ExhaustionBody, setFallbackHeaders, setExhaustionHeaders, type AttemptRecord } from '../lib/fallback-loop.js';
import { routedViaValue } from '../lib/header-value.js';
import { applyTokenBudget, tokenBudgetMessage } from '../lib/guardrails.js';
import { resolveAnthropicModel, claudeFamilyDiscoveryEntries } from '../services/anthropic-map.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdForDispatch } from '../services/model-groups.js';
import type { ReasoningEffort } from '../lib/sampling-params.js';
import { buildModelListing } from '../services/model-listing.js';
import { compressRequest, formatCompressionHeader } from '../services/compression/pipeline.js';
import { normalizeMessageImages } from '../lib/image-normalize.js';

// Anthropic-compatible Messages API (`POST /v1/messages`). This is a thin
// translation layer over the SAME router/fallback/analytics machinery the
// OpenAI `/v1/chat/completions` route uses — it converts the Anthropic wire
// format to our internal (OpenAI-shaped) ChatMessage form on the way in, runs
// the normal routing loop, and converts the result back to Anthropic shape on
// the way out. The OpenAI route is left untouched.
//
// The point is Claude Code (and anything else that speaks the Anthropic SDK):
// point `ANTHROPIC_BASE_URL` at this server, set the API key to the unified
// key, and every `claude-*` request transparently routes to whatever free
// model the chain picks. Auth accepts Anthropic's native `x-api-key` header
// (already handled by extractApiToken) as well as a bearer token.
export const anthropicRouter = Router();

const MAX_RETRIES = 20;
// Anthropic requires `max_tokens`; mirror the OpenAI route's routing-budget
// default when a client somehow omits it.
const DEFAULT_MAX_TOKENS = 1024;
const IMAGE_TOKEN_ESTIMATE = 1000;

// ── Request schema ──────────────────────────────────────────────────────────
// Permissive on purpose: the Anthropic content-block vocabulary grows over
// time (thinking, document, server-tool blocks…) and Claude Code sends blocks
// with extra fields like `cache_control`. We validate the envelope and handle
// the block types we understand by `type`, ignoring the rest — same tolerance
// philosophy as the OpenAI route (#200).
const contentBlockSchema = z.object({ type: z.string() }).passthrough();

const anthropicMessageSchema = z.object({
  // Anthropic's own API only allows user/assistant here, but real clients
  // (Claude Code, routers) sometimes inline a `system` turn in the messages
  // array. Accept it and fold it into the system context rather than 400-ing —
  // same tolerance philosophy as the OpenAI route's developer/function roles.
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
}).passthrough();

const anthropicToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const anthropicToolChoiceSchema = z.object({
  type: z.enum(['auto', 'any', 'tool', 'none']),
  name: z.string().optional(),
}).passthrough();

const messagesSchema = z.object({
  model: z.string().optional(),
  // Anthropic mandates max_tokens; accept omission and clamp non-positive
  // values to the default rather than 400-ing (some clients send 0).
  max_tokens: z.number().int().optional(),
  messages: z.array(anthropicMessageSchema).min(1),
  system: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  // Anthropic's native top_k — forwarded to providers that support it via the
  // platform policy in lib/sampling-params.ts.
  top_k: z.number().int().min(1).nullable().optional(),
  stream: z.boolean().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: anthropicToolChoiceSchema.optional(),
  // Anthropic's native extended-thinking knob. Mapped onto the internal
  // reasoning_effort (see effortFromAnthropicThinking) so providers with
  // request-side reasoning control receive it; platforms without support have
  // it stripped by the policy in lib/sampling-params.ts.
  // `type` is a free string, not the enabled/disabled enum: Anthropic keeps
  // adding modes (Claude Code sends 'adaptive') and validating the enum here
  // turned a knob we only use as a hint into a hard 400 (#632).
  thinking: z.object({
    type: z.string().optional(),
    budget_tokens: z.number().int().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

type AnthropicRequest = z.infer<typeof messagesSchema>;

// Anthropic expresses reasoning control as a token budget; our internal knob
// is OpenAI's coarse effort scale. Thresholds follow Anthropic's own guidance
// bands (minimum budget 1024; multi-10k budgets for hard problems).
export function effortFromAnthropicThinking(
  thinking: { type?: string; budget_tokens?: number } | null | undefined,
): ReasoningEffort | undefined {
  if (!thinking) return undefined;
  const type = thinking.type?.trim().toLowerCase();
  if (type === 'disabled' || type === 'off' || type === 'none') return 'none';
  const budget = thinking.budget_tokens;
  // Model-managed modes ('adaptive', 'auto') without an explicit budget mean
  // "you decide how much" — forward no knob at all and let the provider
  // default stand, same as a -1 Gemini thinking budget.
  if (budget == null && (type === 'adaptive' || type === 'auto')) return undefined;
  if (budget == null) return 'medium';
  if (budget < 4096) return 'low';
  if (budget < 16384) return 'medium';
  return 'high';
}

// ── Response shape ──────────────────────────────────────────────────────────
type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown; thought_signature?: string }
// The model's reasoning trace, rendered on Anthropic's native wire shape. The
// signature field is required by the shape but is only meaningful for real
// Anthropic models (replay verification); empty here. Our request converter
// drops thinking blocks on the way in, so replay is safe.
interface AnthropicThinkingBlock { type: 'thinking'; thinking: string; signature: string }
type AnthropicResponseBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock;

interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: AnthropicStopReason;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

function sendError(res: Response, status: number, errorType: string, message: string): void {
  res.status(status).json({ type: 'error', error: { type: errorType, message } });
}

// The shared exhaustion body's `type` strings are chosen to be valid on the
// OpenAI-shaped surfaces; several of them are not Anthropic error types. Remap
// them onto Anthropic's vocabulary via the body's coarse `kind` so this
// surface stays wire-correct: auth/upstream failures → 'api_error', pool
// unavailability → 'overloaded_error', context exhaustion → Anthropic's 413
// 'request_too_large', model-gone → 'not_found_error'.
function anthropicErrorType(body: ExhaustionBody): string {
  if (body.kind === 'auth' || body.kind === 'upstream') return 'api_error';
  if (body.kind === 'unavailable') return 'overloaded_error';
  if (body.kind === 'context_too_large') return 'request_too_large';
  if (body.kind === 'model_not_found') return 'not_found_error';
  return body.type;
}

// Render an exhaustion body on the Anthropic wire shape, carrying the
// machine-readable extras (`code`, `retryAtMs`) alongside Anthropic's standard
// type/message and stamping the matching Retry-After header. Extra keys on the
// error object are ignored by Anthropic SDKs, so this stays wire-compatible.
function sendExhaustion(res: Response, body: ExhaustionBody): void {
  setExhaustionHeaders(res, body);
  res.status(body.status).json({
    type: 'error',
    error: {
      type: anthropicErrorType(body),
      message: body.message,
      ...(body.code ? { code: body.code } : {}),
      ...(body.retryAtMs != null ? { retryAtMs: body.retryAtMs } : {}),
    },
  });
}

function newMessageId(): string {
  return `msg_${crypto.randomBytes(12).toString('hex')}`;
}

// ── Auth (shared with the OpenAI route) ─────────────────────────────────────
function authenticate(req: Request, res: Response): boolean {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    sendError(res, 401, 'authentication_error', 'Invalid API key');
    return false;
  }
  return true;
}

// ── Request translation: Anthropic → internal (OpenAI-shaped) ───────────────
function flattenSystem(system: AnthropicRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .map(block => (typeof (block as any).text === 'string' ? (block as any).text : ''))
    .filter(Boolean)
    .join('\n');
}

// An Anthropic tool_result's content is a string or an array of blocks; flatten
// to text for the internal `tool` message (we don't forward tool images).
function flattenToolResult(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map(block => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object' && typeof (block as any).text === 'string') return (block as any).text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// Anthropic image block → OpenAI `image_url` block, so vision models keep
// working through the same routing path the OpenAI route uses.
function imageBlockToUrl(block: any): string | null {
  const src = block?.source;
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'base64' && src.media_type && src.data) {
    return `data:${src.media_type};base64,${src.data}`;
  }
  if (src.type === 'url' && typeof src.url === 'string') return src.url;
  return null;
}

function convertToolChoice(choice: AnthropicRequest['tool_choice']): ChatToolChoice | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto': return 'auto';
    case 'none': return 'none';
    case 'any': return 'required'; // Anthropic "any" == OpenAI "required"
    case 'tool': return choice.name ? { type: 'function', function: { name: choice.name } } : 'required';
    default: return undefined;
  }
}

interface ConvertedRequest {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  hasImage: boolean;
  wantsTools: boolean;
  /** Reasons the request carried documents we cannot convert. Non-empty means
   *  the caller must be told, not served — see the rejection below. */
  documentRejections: string[];
}

function convertRequest(input: AnthropicRequest): ConvertedRequest {
  const messages: ChatMessage[] = [];
  const documentRejections: string[] = [];
  let hasImage = false;

  const system = flattenSystem(input.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const message of input.messages) {
    // A `system` turn inlined in the messages array → fold into system context
    // (flatten text blocks). Anthropic clients occasionally send this; the real
    // API rejects it, but we'd rather route the request than 400.
    if (message.role === 'system') {
      const sysText = typeof message.content === 'string'
        ? message.content
        : message.content.map(b => (typeof (b as any).text === 'string' ? (b as any).text : '')).filter(Boolean).join('\n');
      if (sysText) messages.push({ role: 'system', content: sysText });
      continue;
    }

    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    const textParts: string[] = [];
    const imageBlocks: ChatContentBlock[] = [];
    const toolCalls: ChatToolCall[] = [];
    const toolResults: ChatMessage[] = [];

    for (const block of message.content) {
      const type = (block as any).type;
      if (type === 'text') {
        if (typeof (block as any).text === 'string' && (block as any).text.length > 0) {
          textParts.push((block as any).text);
        }
      } else if (type === 'image') {
        const url = imageBlockToUrl(block);
        if (url) { imageBlocks.push({ type: 'image_url', image_url: { url } } as ChatContentBlock); hasImage = true; }
      } else if (type === 'tool_use') {
        const thoughtSignature = (block as any).thought_signature ?? (block as any).thoughtSignature;
        toolCalls.push({
          id: String((block as any).id ?? ''),
          type: 'function',
          function: { name: String((block as any).name ?? ''), arguments: JSON.stringify((block as any).input ?? {}) },
          ...(typeof thoughtSignature === 'string' && thoughtSignature.length > 0 ? { thought_signature: thoughtSignature } : {}),
        });
      } else if (type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: String((block as any).tool_use_id ?? ''),
          content: flattenToolResult((block as any).content),
        });
      } else if (type === 'document') {
        // A document that is already text costs nothing to inline. One that
        // needs decoding cannot be served by any provider here, and dropping
        // it would answer confidently about a document the model never saw.
        const result = convertDocumentBlock(block);
        if (result.ok) textParts.push(result.text);
        else documentRejections.push(result.reason);
      }
      // Other unknown block types (thinking, …) are intentionally dropped.
    }

    const text = textParts.join('\n');

    if (message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // User turn. Anthropic carries tool results inside a user message; split
      // them into the `tool` messages OpenAI expects (which must directly
      // follow the assistant's tool_calls), then any fresh user text/images.
      messages.push(...toolResults);
      if (imageBlocks.length > 0) {
        const blocks: ChatContentBlock[] = [];
        if (text.length > 0) blocks.push({ type: 'text', text });
        blocks.push(...imageBlocks);
        messages.push({ role: 'user', content: blocks });
      } else if (text.length > 0) {
        messages.push({ role: 'user', content: text });
      }
    }
  }

  const tools: ChatToolDefinition[] | undefined = input.tools?.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object', properties: {} } },
  }));

  return {
    messages,
    tools,
    tool_choice: convertToolChoice(input.tool_choice),
    hasImage,
    wantsTools: (tools?.length ?? 0) > 0,
    documentRejections,
  };
}

function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
}

// Model resolution (Claude family → auto | pinned catalog model) lives in
// services/anthropic-map.ts so the dashboard mapping editor and this route
// share one source of truth. Claude Code keeps its built-in `claude-*` names;
// by default every family maps to "auto" (the router picks a free model).

// A stable created_at for the Anthropic /v1/models entries; clients only use it
// for display ordering, so a constant avoids needless churn.
const MODEL_CREATED_AT = '2026-01-01T00:00:00Z';

// ── Response translation: internal → Anthropic ──────────────────────────────
function mapStopReason(finishReason: string | null | undefined, hadToolCalls: boolean): AnthropicStopReason {
  if (hadToolCalls || finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'stop' || finishReason === 'content_filter' || finishReason == null) return 'end_turn';
  return 'end_turn';
}

function parseToolInput(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return {}; }
}

function toAnthropicContent(message: ChatMessage | undefined): AnthropicResponseBlock[] {
  const blocks: AnthropicResponseBlock[] = [];
  // Reasoning output (native provider reasoning_content, or extracted from an
  // inline <think> block by lib/think-tags.ts) → Anthropic thinking block,
  // first per Anthropic convention.
  const reasoning = message?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    blocks.push({ type: 'thinking', thinking: reasoning, signature: '' });
  }
  const text = contentToString(message?.content ?? '');
  if (text.length > 0) blocks.push({ type: 'text', text });
  for (const call of message?.tool_calls ?? []) {
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolInput(call.function.arguments),
    };
    if (call.thought_signature) block.thought_signature = call.thought_signature;
    blocks.push(block);
  }
  return blocks;
}

// ── SSE helpers ─────────────────────────────────────────────────────────────
function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Convert rescued inline tool calls (parsed out of a model that serialized its
// tool call as TEXT) into OpenAI-shaped tool_calls, so toAnthropicContent /
// the streaming tool_use emitter render them as Anthropic tool_use blocks —
// the same rescue /chat/completions and /v1/responses already apply (#231).
function rescuedToToolCalls(
  calls: Array<{ name: string; arguments: string }>,
  schemas: Map<string, unknown>,
): ChatToolCall[] {
  return calls.map((c, i) => ({
    id: `toolu_${crypto.randomBytes(8).toString('hex')}_rescued_${i + 1}`,
    type: 'function' as const,
    function: { name: c.name, arguments: repairToolArguments(c.arguments, schemas.get(c.name) as any) },
  }));
}

anthropicRouter.post('/messages', async (req: Request, res: Response) => {
  const start = Date.now();
  if (!authenticate(req, res)) return;

  const parsed = messagesSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5).join(', ');
    console.warn(`[anthropic] 400 invalid /v1/messages request: ${detail}`);
    sendError(res, 400, 'invalid_request_error', `Invalid request: ${detail}`);
    return;
  }

  const body = parsed.data;
  const requestedModel = body.model ?? 'auto';
  const routedModel = body.model?.startsWith('claude/')
    ? body.model.slice('claude/'.length)
    : body.model;
  // The Anthropic wire format requires max_tokens, but OUR default injection
  // must not change the budget gate's verdict: gating AFTER defaulting made a
  // no-max_tokens request 413 here (input + 1024 over budget) where the chat
  // surface would cap it and serve. Gate on what the client actually sent,
  // then resolve the default against the budget remainder.
  const clientMaxTokens = body.max_tokens != null && body.max_tokens > 0 ? body.max_tokens : undefined;
  const { temperature, top_p, stream } = body;

  const converted = convertRequest(body);
  // Rejected before routing, and before compression: this is our verdict, not
  // a provider's. Entering the failover loop would spend quota on a request
  // every candidate would fail identically, and book it as provider failure.
  if (converted.documentRejections.length > 0) {
    const message = documentRejectionMessage(converted.documentRejections);
    console.warn(`[anthropic] 400 unsupported document block: ${converted.documentRejections.join('; ')}`);
    sendError(res, 400, 'invalid_request_error', message);
    return;
  }
  let { messages } = converted;
  const { tools, tool_choice, hasImage, wantsTools } = converted;
  // Downscale over-threshold inline images before compression/estimation so
  // the budget, routing, and upstream transfer all see the shrunk bytes
  // (see lib/image-normalize.ts). The cache-control detection below reads the
  // RAW wire body, and normalization mutates urls in place keeping the blocks
  // (and any cache_control on them) intact — neither is disturbed.
  await normalizeMessageImages(messages);
  const systemHasCacheControl = Array.isArray(body.system)
    && body.system.some(block => block && typeof block === 'object' && 'cache_control' in block);
  const messageHasCacheControl = body.messages.some(message =>
    Array.isArray(message.content)
    && message.content.some(block => block && typeof block === 'object' && 'cache_control' in block));
  const compressionResult = compressRequest(messages, {
    header: req.headers['x-freellm-compress'],
    tools,
    // Claude Code normally marks the system prefix. If a later native message
    // carries a breakpoint, conservatively cap the translated prefix at
    // lossless rather than risk invalidating upstream prompt-cache semantics.
    cacheControlPrefixLength: messageHasCacheControl ? messages.length : (systemHasCacheControl ? 1 : 0),
  });
  messages = compressionResult.messages;
  res.setHeader('X-FreeLLM-Compress', formatCompressionHeader(compressionResult));

  const estimatedInputTokens = estimateTokens(messages);
  const imageCount = messages.reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter(b => (b as any)?.type === 'image_url').length : 0), 0);

  // Guardrail: per-request token budget (request_max_tokens_budget, default
  // off). A client-set max_tokens can only pass or reject; an omitted one is
  // capped to the budget remainder, mirroring /v1/chat/completions.
  const budgetCheck = applyTokenBudget(estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE, clientMaxTokens);
  if (budgetCheck.rejection) {
    sendError(res, 413, 'invalid_request_error', tokenBudgetMessage(budgetCheck.rejection));
    return;
  }
  const max_tokens = clientMaxTokens
    ?? (budgetCheck.maxTokens != null ? Math.min(DEFAULT_MAX_TOKENS, budgetCheck.maxTokens) : DEFAULT_MAX_TOKENS);

  const completionOptions = {
    temperature, max_tokens, top_p, top_k: body.top_k ?? undefined, tools, tool_choice,
    // Native `thinking: {type, budget_tokens}` → the same internal knob the
    // OpenAI surface's reasoning_effort feeds; absent when the client sent none.
    reasoning_effort: effortFromAnthropicThinking(body.thinking),
  };
  // Capped output reserve so a large max_tokens can't falsely exclude the model
  // pool (#470); input + images count in full. Threaded to the router
  // separately: it is exact and must not be inflated by the context-window
  // safety margin (#956 review).
  const outputReserve = routingReserveTokens(max_tokens);
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + outputReserve;

  // Resolve the model through the operator's Claude-family map (opus/sonnet/
  // haiku/default → auto | a pinned catalog model). A concrete catalog id pins
  // directly. `pinned` drives the analytics requested-model label.
  const resolved = resolveAnthropicModel(routedModel);
  const pinnedModelId = resolved.pinned ? (body.model ?? null) : null;

  // Session affinity: Claude Code stamps every request in a session with
  // X-Claude-Code-Session-Id. When auto-routing, stick the whole session to one
  // model so it doesn't flap between free providers mid-conversation.
  const rawSession = req.headers['x-claude-code-session-id'] ?? req.headers['x-session-id'];
  const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;

  // Same-model cross-provider failover (#932). A pin resolves to ONE catalog
  // row, and until now that row was the only thing the request preferred: when
  // its provider failed, the loop walked the rest of the catalog and answered
  // with a completely different model. The OpenAI, Responses and inbound-chat
  // surfaces already avoid that by routing a pinned id over its unified model
  // group as a STRICT chain (#335) — every provider serving the same logical
  // model, and nothing else. Build the identical chain here so /v1/messages
  // behaves the same.
  //
  // Only the pinned paths change. A Claude family alias mapped to 'auto' (the
  // default for opus/sonnet/haiku/default) resolves to no model at all and
  // keeps auto-routing over the full chain exactly as before.
  let groupChain: ChainRow[] | undefined;
  // Sticky scope for a group-pinned request: bucket by the pinned catalog id so
  // the session prefers its last successful provider of THIS model without
  // leaking affinity across groups. Undefined for auto (the global scope).
  let stickyScope: string | undefined;
  if (resolved.modelId) {
    const dispatch = isUnifyEnabled() ? resolveRequestedIdForDispatch(resolved.modelId, getModelGroups()) : null;
    const members = dispatch?.memberDbIds ?? null;
    if (members && members.length > 0) {
      const chain = resolveModelGroupCandidates(members, dispatch!.demotedDbIds);
      // An empty chain would mean the pinned row is no longer routable at all;
      // this surface is lenient, so leave the legacy single-row pin in place
      // rather than failing the request.
      if (chain.length > 0) {
        groupChain = chain;
        stickyScope = resolved.modelId;
      }
    }
  }

  let preferredModel = resolved.preferredModelDbId;
  if (groupChain) {
    // The strict chain already fixes the model; the only preference left is
    // which member served this session last. Passing a non-member would make
    // routeRequest splice an off-group model into the chain and break the pin.
    const sticky = getStickyModel(messages, sessionId, stickyScope);
    preferredModel = (sticky != null && groupChain.some(r => r.model_db_id === sticky)) ? sticky : undefined;
  }
  if (preferredModel == null && !groupChain) preferredModel = resolveStickyPreference(getStickyModel(messages, sessionId));

  // Thin adapter over the shared fallback loop (lib/fallback-loop.ts): the
  // cooldown/skip/penalty/exhaustion machinery is shared, only the Anthropic
  // request/stream translation lives here. This converged three drifts on this
  // surface: it now honors a provider Retry-After and day-benches a 403 (via the
  // shared cooldown), returns a shared exhaustion body (a 400 invalid_request
  // when every provider rejected the request, not always a 429), and applies the
  // inline tool-call dialect rescue that the OpenAI/Responses surfaces carry.
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
  const dispatchOptions = { ...completionOptions, signal: AbortSignal.any([clientAbort.signal, hedgeAbort.signal]) };

  await runFallbackLoop({
    maxRetries: MAX_RETRIES,
    state,
    attemptLog,
    clientGone: () => clientGone,
    abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
    route: () => routeRequest(estimatedTotal, state.skipKeys.size > 0 ? state.skipKeys : undefined, preferredModel, hasImage, wantsTools, state.skipModels.size > 0 ? state.skipModels : undefined, groupChain, false, state.skipPlatforms.size > 0 ? state.skipPlatforms : undefined, outputReserve),
    dispatch: async (route, attempt, dispatchCtx) => {
      if (stream) {
        try {
          await streamCompletion(res, route, messages, dispatchOptions, {
            start, attempt, attemptLog, clientGone: () => clientGone, requestedModel, estimatedInputTokens, tools, pinnedModelId,
            sessionId, pinned: resolved.pinned, stickyScope, disarmHedge: dispatchCtx.disarmHedge,
          });
          return 'done';
        } catch (err: any) {
          // The stream already committed (message_start sent) and surfaced its
          // own error event; stop without failover or a second response.
          if (err instanceof StreamAlreadyStarted) return 'committed';
          throw err;
        }
      }

      const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, dispatchOptions);
      const respMsg = result.choices?.[0]?.message;
      const respText = contentToString(respMsg?.content ?? '');
      let respToolCalls = respMsg?.tool_calls ?? [];

      // Empty completion → fail over via the shared loop, exactly like the
      // OpenAI route; finish_reason 'length' (whole output budget spent on
      // hidden reasoning) skips the cooldown/penalty.
      if (!respText && respToolCalls.length === 0) {
        throw Object.assign(
          new Error(`empty completion from ${route.displayName}`),
          result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
        );
      }
      // #809: bare "safe"/"unsafe" classification output from a relay is an
      // upstream filter, not the requested model — fail over like an empty
      // completion.
      if (isUpstreamClassificationOutput(respText, route.platform) && respToolCalls.length === 0) {
        throw Object.assign(
          new Error(`empty completion from ${route.displayName} (upstream classification output)`),
          result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
        );
      }

      // Inline tool-call dialect rescue (#231): a tool-bearing request answered
      // with the call serialized as TEXT → re-parse it into structured tool_use
      // so Claude Code's agent loop keeps working; a detected-but-unparseable
      // dialect is a dead turn and fails over like an empty completion. Same
      // rescue /chat/completions and /v1/responses already apply.
      if (wantsTools && respMsg && respToolCalls.length === 0 && respText) {
        const rescue = rescueInlineToolCalls(respText, new Set((tools ?? []).map(t => t.function.name)));
        if (rescue.detected) {
          if (!rescue.calls) {
            throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${respText.slice(0, 120)}`);
          }
          const schemas = toolSchemaMap(tools);
          respMsg.tool_calls = rescuedToToolCalls(rescue.calls, schemas);
          respMsg.content = rescue.cleanText.length > 0 ? rescue.cleanText : null;
          if (result.choices?.[0]) result.choices[0].finish_reason = 'tool_calls';
          respToolCalls = respMsg.tool_calls;
          console.log(`[Anthropic] Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName} into tool_use`);
        }
      }

      // Repair double-encoded tool arguments against the request schemas, so
      // strict Anthropic clients (Claude Code) get clean JSON inputs.
      if (respToolCalls.length) {
        const schemas = toolSchemaMap(tools);
        for (const tc of respToolCalls) {
          if (tc?.function?.arguments != null) {
            tc.function.arguments = repairToolArguments(tc.function.arguments, schemas.get(tc.function.name));
          }
        }
        // Opt-in schema verdict on what the repair could not fix. This surface
        // is where the silent failure was worst: parseToolInput turns
        // unparseable arguments into `input: {}`, so the client sees a tool_use
        // block with nothing in it and no indication anything went wrong.
        if (isToolArgumentValidationEnabled()) {
          const invalid = invalidToolCallReasons(respToolCalls, schemas);
          if (invalid.length > 0) throw invalidToolArgumentsError(route.displayName, invalid);
        }
      }

      const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
      const completionTokens = result.usage?.completion_tokens ?? Math.ceil((respText.length + respToolCalls.reduce((n, c) => n + c.function.arguments.length, 0)) / 4);

      recordUpstreamSuccess(route, result.usage?.total_tokens ?? promptTokens + completionTokens);
      // Remember this model for the rest of the auto-routed session. A pin used
      // to make this a no-op (the pin fixed the model); a group pin still has a
      // provider choice to remember, recorded under the group's own scope.
      if (!resolved.pinned || stickyScope) setStickyModel(messages, route.modelDbId, sessionId, stickyScope);

      const anthropicResponse: AnthropicMessageResponse = {
        id: newMessageId(),
        type: 'message',
        role: 'assistant',
        model: requestedModel,
        content: toAnthropicContent(respMsg),
        stop_reason: mapStopReason(result.choices?.[0]?.finish_reason ?? null, respToolCalls.length > 0),
        stop_sequence: null,
        usage: { input_tokens: promptTokens, output_tokens: completionTokens },
      };

      res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
      setFallbackHeaders(res, attempt, attemptLog);
      logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null, null, pinnedModelId);
      res.json(anthropicResponse);
      return 'done';
    },
    logFailure: (route, err) => {
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, sanitizeProviderErrorMessage(err.message), null, pinnedModelId);
    },
    onFatal: (route, err, attempt) => {
      setFallbackHeaders(res, attempt, attemptLog);
      sendError(res, 502, 'api_error', `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`);
    },
    onRoutingExhausted: (lastError, routeErr, exhaustion, info) => {
      setFallbackHeaders(res, info.attempts.length, info.attempts);
      sendExhaustion(res, exhaustion);
    },
    onExhausted: (exhaustion, info) => {
      setFallbackHeaders(res, info.attempts.length, info.attempts);
      sendExhaustion(res, exhaustion);
    },
  });
});

// Thrown by streamCompletion once the SSE response is underway, so the outer
// loop knows the request is finished (honestly errored mid-stream) and must
// not fail over or send a second response.
class StreamAlreadyStarted extends Error {}

interface StreamCtx {
  start: number;
  attempt: number;
  attemptLog: AttemptRecord[];
  clientGone: () => boolean;
  requestedModel: string;
  estimatedInputTokens: number;
  tools?: ChatToolDefinition[];
  pinnedModelId: string | null;
  sessionId?: string;
  pinned: boolean;
  // Sticky bucket for a group-pinned request; undefined for auto routing.
  stickyScope?: string;
  /** Cancel this attempt's time-budget hedge once the stream commits. */
  disarmHedge: () => void;
}

// Consume the provider's OpenAI-style stream and re-emit it as the Anthropic
// SSE event sequence Claude Code expects:
//   message_start → (content_block_start → content_block_delta* →
//   content_block_stop)* → message_delta → message_stop
// Text is streamed incrementally as text_delta; tool calls are buffered across
// deltas and emitted as tool_use blocks (input_json_delta) once complete — the
// same buffering the OpenAI route does, since partial tool-call JSON isn't
// safely forwardable mid-flight.
async function streamCompletion(
  res: Response,
  route: RouteResult,
  messages: ChatMessage[],
  options: any,
  ctx: StreamCtx,
): Promise<void> {
  let messageStarted = false; // doubles as "headers + message_start sent" = committed
  let textBlockOpen = false;
  let textBlockIndex = -1;
  let nextIndex = 0;
  let outputChars = 0;
  let upstreamFinish: string | null = null;
  const toolAcc = new Map<number, { id?: string; name: string; args: string; thought_signature?: string }>();

  // Inline-dialect hold window (#231): the first text is held until it either
  // matches a tool-call dialect marker (held to the end and rescued into
  // tool_use blocks) or provably cannot (flushed and streamed normally). This is
  // also the commit point convergence — message_start is not sent until the
  // first MEANINGFUL content, so a stream that opens with a dialect marker and
  // then turns out unparseable fails over invisibly (previously this surface
  // committed on the first non-empty text and had no dialect rescue at all).
  let dialectMode: 'undecided' | 'passthrough' | 'dialect' = 'undecided';
  let heldText = '';

  const ensureMessageStart = () => {
    if (messageStarted) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
    setFallbackHeaders(res, ctx.attempt, ctx.attemptLog);
    // Committed: the answer is on its way, so the retry budget must no longer
    // cancel this attempt (it could not fail over now anyway).
    ctx.disarmHedge();
    writeSse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: newMessageId(), type: 'message', role: 'assistant', model: ctx.requestedModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: ctx.estimatedInputTokens, output_tokens: 0 },
      },
    });
    messageStarted = true;
  };

  // Reasoning output (delta.reasoning_content from providers / the <think>
  // extractor, delta.reasoning from Ollama-style upstreams) is buffered and
  // emitted as one complete thinking block right before the first text/tool
  // block. Buffering (not live thinking_delta streaming) keeps the commit
  // point where it was: a stream that produces ONLY reasoning and dies still
  // fails over invisibly, exactly like the OpenAI surface's preamble hold.
  let reasoningBuf = '';
  const flushThinking = () => {
    if (reasoningBuf.length === 0) return;
    const idx = nextIndex++;
    writeSse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
    writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: reasoningBuf } });
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
    outputChars += reasoningBuf.length;
    reasoningBuf = '';
  };

  // Commit (if needed), open the text block (if needed), and stream `text`.
  const emitText = (text: string) => {
    ensureMessageStart();
    if (!textBlockOpen) {
      flushThinking(); // thinking block precedes the text block
      textBlockIndex = nextIndex++;
      writeSse(res, 'content_block_start', { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
      textBlockOpen = true;
    }
    writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text } });
    outputChars += text.length;
  };

  try {
    const gen = route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, options);

    for await (const chunk of gen) {
      if (ctx.clientGone()) break; // client hung up: stop pulling; reader.cancel() aborts upstream
      const anyChunk = chunk as Record<string, any>;

      // In-band provider error frame (e.g. Groq emits {"error":…} inside a 200
      // stream). Before message_start: retryable → fail over invisibly. After:
      // surface an Anthropic `error` event and stop.
      if (anyChunk.error && !anyChunk.choices) {
        const msg = anyChunk.error.message ?? JSON.stringify(anyChunk.error).slice(0, 200);
        if (!messageStarted) throw new Error(`in-band provider error from ${route.displayName}: ${msg}`);
        writeSse(res, 'error', { type: 'error', error: { type: 'api_error', message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(String(msg))}` } });
        res.end();
        logRequest(route.platform, route.modelId, route.keyId, 'error', ctx.estimatedInputTokens, outputChars, Date.now() - ctx.start, `in-band error frame: ${sanitizeProviderErrorMessage(String(msg))}`, null, ctx.pinnedModelId);
        throw new StreamAlreadyStarted();
      }

      const choice = anyChunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) upstreamFinish = choice.finish_reason;

      for (const tc of choice.delta?.tool_calls ?? []) {
        const idx = (tc as any).index ?? 0;
        if (!toolAcc.has(idx)) toolAcc.set(idx, { id: undefined, name: '', args: '' });
        const acc = toolAcc.get(idx)!;
        if (tc.id && !acc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        const thoughtSignature = (tc as any).thought_signature ?? (tc as any).thoughtSignature;
        if (typeof thoughtSignature === 'string' && thoughtSignature.length > 0 && !acc.thought_signature) {
          acc.thought_signature = thoughtSignature;
        }
      }

      // Reasoning deltas: providers emit reasoning_content (or Ollama-style
      // `reasoning`); the shared <think> extractor emits reasoning_content.
      const reasoningDelta = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) reasoningBuf += reasoningDelta;

      const text = typeof choice.delta?.content === 'string' ? choice.delta.content : '';
      if (text.length === 0) continue;

      if (dialectMode === 'passthrough') {
        emitText(text);
      } else {
        heldText += text;
        if (dialectMode === 'undecided') {
          const probe = heldText.trimStart();
          if (startsWithDialectMarker(probe)) {
            dialectMode = 'dialect';
          } else if (!couldBecomeDialectMarker(probe) || heldText.length > 256) {
            dialectMode = 'passthrough';
            emitText(heldText);
            heldText = '';
          }
        }
        // else: still a strict prefix of a marker — keep holding.
      }
    }

    // Assemble buffered tool calls: synthesize missing ids, repair args against
    // the request schemas, drop any that still aren't valid JSON.
    const schemas = toolSchemaMap(ctx.tools);
    let synthetic = 0;
    const completedCalls: Array<{ id: string; name: string; arguments: string; thought_signature?: string }> = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({
        id: acc.id && acc.id.length > 0 ? acc.id : `toolu_${crypto.randomBytes(8).toString('hex')}_${++synthetic}`,
        name: acc.name,
        arguments: repairToolArguments(acc.args || '{}', schemas.get(acc.name)),
        ...(acc.thought_signature ? { thought_signature: acc.thought_signature } : {}),
      }))
      .filter(c => { try { JSON.parse(c.arguments); return c.name.length > 0; } catch { return false; } });

    // Resolve the dialect hold window now the full text is known. Held text was
    // never emitted, so a dead dialect turn can still fail over (nothing has been
    // committed). A rescued dialect becomes tool_use blocks; leftover clean text
    // is emitted as a text block first.
    if (heldText.length > 0) {
      const rescue = ((ctx.tools?.length ?? 0) > 0 && (dialectMode === 'dialect' || containsDialectMarker(heldText)))
        ? rescueInlineToolCalls(heldText, new Set((ctx.tools ?? []).map(t => t.function.name)))
        : { detected: false as const, calls: null, cleanText: heldText };
      if (rescue.detected && !rescue.calls) {
        throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${heldText.slice(0, 120)}`);
      }
      if (rescue.detected && rescue.calls) {
        if (rescue.cleanText.length > 0) emitText(rescue.cleanText);
        for (const c of rescue.calls) {
          const repaired = repairToolArguments(c.arguments, schemas.get(c.name));
          if (c.name.length === 0) continue;
          try { JSON.parse(repaired); } catch { continue; }
          completedCalls.push({ id: `toolu_${crypto.randomBytes(8).toString('hex')}_rescued_${++synthetic}`, name: c.name, arguments: repaired });
        }
        console.log(`[Anthropic] Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName} into tool_use`);
      } else {
        emitText(heldText);
      }
      heldText = '';
    }

    // Opt-in schema verdict, same rule as the non-streaming surface above and
    // as /chat/completions: this is the surface the silent failure hurt most,
    // and Claude Code streams. Placed after the dialect rescue so a rescued
    // call is judged too, and gated on `!messageStarted` — once message_start
    // has gone out there is no failing over, and tearing the SSE stream down
    // would be worse for the client than a tool_use the schema dislikes.
    if (isToolArgumentValidationEnabled() && !messageStarted && completedCalls.length > 0) {
      const invalid = invalidToolCallReasons(
        completedCalls.map(c => ({ function: { name: c.name, arguments: c.arguments } })),
        schemas,
      );
      if (invalid.length > 0) throw invalidToolArgumentsError(route.displayName, invalid);
    }

    // Nothing usable came out — fail over (message_start was never sent, so the
    // client never saw this attempt).
    if (!messageStarted && completedCalls.length === 0) {
      // Disconnect before the commit point: the pump loop broke with nothing
      // accumulated because the CLIENT left, not because the provider failed —
      // benching a healthy model+key for it was wrong. StreamAlreadyStarted
      // maps to 'committed' in the dispatcher: stop, no failover, no
      // exhaustion render (the socket is gone anyway).
      if (ctx.clientGone()) {
        console.log(`[Anthropic] client disconnected before first token from ${route.displayName} — dropping attempt without benching`);
        throw new StreamAlreadyStarted();
      }
      // finish_reason 'length' = the model spent the whole output budget on
      // hidden reasoning before any visible text: fail over, but skip the
      // cooldown/penalty (not a provider-health signal).
      throw Object.assign(
        new Error(`empty completion from ${route.displayName} (stream produced no content and no tool calls)`),
        upstreamFinish === 'length' ? { skipBench: true } : {},
      );
    }

    ensureMessageStart();
    if (textBlockOpen) writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
    // Residual reasoning: tool-only turns (no text block ever opened) and
    // reasoning that arrived after the text block was already streaming.
    flushThinking();

    for (const call of completedCalls) {
      const idx = nextIndex++;
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: {
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: {},
          ...(call.thought_signature ? { thought_signature: call.thought_signature } : {}),
        },
      });
      writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: call.arguments } });
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
      outputChars += call.arguments.length;
    }

    const stopReason = mapStopReason(upstreamFinish, completedCalls.length > 0);
    const outputTokens = Math.ceil(outputChars / 4);
    writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
    writeSse(res, 'message_stop', { type: 'message_stop' });
    res.end();

    recordUpstreamSuccess(route, ctx.estimatedInputTokens + outputTokens);
    if (!ctx.pinned || ctx.stickyScope) setStickyModel(messages, route.modelDbId, ctx.sessionId, ctx.stickyScope);
    logRequest(route.platform, route.modelId, route.keyId, 'success', ctx.estimatedInputTokens, outputTokens, Date.now() - ctx.start, null, null, ctx.pinnedModelId);
  } catch (err: any) {
    if (err instanceof StreamAlreadyStarted) throw err;
    // Client abort mid-stream: the pump's own `if (ctx.clientGone()) break`
    // can lose the race against the fetch-signal rejection, so the abort may
    // surface here instead. Rethrow — the shared loop's client-abort branch
    // stops the ladder without benching or an error log row (the socket is
    // gone; nothing to render).
    if (isClientAbortError(err)) throw err;
    if (messageStarted) {
      // Real payload already reached the client — finish the SSE response
      // honestly instead of leaving Claude Code hanging, and stop the retry loop.
      writeSse(res, 'error', { type: 'error', error: { type: 'api_error', message: `Provider error (${route.displayName}): stream interrupted` } });
      try { res.end(); } catch { /* socket gone */ }
      logRequest(route.platform, route.modelId, route.keyId, 'error', ctx.estimatedInputTokens, outputChars, Date.now() - ctx.start, sanitizeProviderErrorMessage(err.message), null, ctx.pinnedModelId);
      throw new StreamAlreadyStarted();
    }
    // Headers never sent — bubble to the outer loop for failover.
    throw err;
  }
}

// Anthropic token-counting endpoint. Claude Code calls this to size context
// windows; we return a heuristic estimate (the proxy doesn't run a tokenizer).
anthropicRouter.post('/messages/count_tokens', (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;
  const parsed = messagesSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request_error', 'Invalid request');
    return;
  }
  const converted = convertRequest(parsed.data);
  // Same verdict as POST /messages, so a client sizing a context window learns
  // the document is unusable here rather than getting a count for a prompt we
  // would go on to refuse.
  if (converted.documentRejections.length > 0) {
    sendError(res, 400, 'invalid_request_error', documentRejectionMessage(converted.documentRejections));
    return;
  }
  const { messages, tools } = converted;
  const compressionResult = compressRequest(messages, {
    header: req.headers['x-freellm-compress'],
    tools,
    recordStats: false,
  });
  res.setHeader('X-FreeLLM-Compress', formatCompressionHeader(compressionResult));
  res.json({ input_tokens: estimateTokens(compressionResult.messages) });
});

// Anthropic-compatible GET /v1/models. Content-negotiated: only answers when
// the caller speaks Anthropic (sends an `anthropic-version` header, as Claude
// Code does) — otherwise it calls next() and the OpenAI-shaped handler in
// proxyRouter serves the same path. Lists the SAME catalog as the OpenAI
// endpoint (real free models that can serve a request right now, plus "auto").
// Nothing here is hosted Claude, and no entry claims to be.
//
// One entry per Claude family (claude-sonnet-4-5 and friends) rides along so
// clients that only accept Claude-shaped ids can discover anything at all; see
// CLAUDE_FAMILY_ALIASES for why, and note /messages already routed those ids
// long before they were listed here.
//
// Optional `claude/<real-id>` aliases let Claude Code's gateway picker discover
// the full catalog; /messages strips the synthetic prefix before routing.
anthropicRouter.get('/models', (req: Request, res: Response, next: NextFunction) => {
  if (!req.headers['anthropic-version']) return next(); // OpenAI client → proxyRouter
  if (!authenticate(req, res)) return;

  const { models } = buildModelListing();
  const available = models.filter(m => m.available === 1);
  const aliasesEnabled = getSetting('expose_cc_discovery_aliases') === '1';
  const data = [
    { type: 'model' as const, id: 'auto', display_name: 'Auto (router picks the best available model)', created_at: MODEL_CREATED_AT },
    // Only when something can actually serve them: advertising a Sonnet slot
    // backed by an empty pool would trade "0 models" for a model that 503s.
    ...(available.length > 0
      ? claudeFamilyDiscoveryEntries().map(a => ({
        type: 'model' as const,
        id: a.id,
        display_name: a.displayName,
        created_at: MODEL_CREATED_AT,
      }))
      : []),
    ...available.map(m => ({ type: 'model' as const, id: m.id, display_name: m.name, created_at: MODEL_CREATED_AT })),
    ...(aliasesEnabled
      ? available.map(m => ({
        type: 'model' as const,
        id: `claude/${m.id}`,
        display_name: `${m.name} (Claude Code)`,
        created_at: MODEL_CREATED_AT,
      }))
      : []),
  ];
  res.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null });
});
