import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';
import { routeRequest, hasEnabledVisionModel, hasEnabledToolsModel, resolveStickyPreference, routingReserveTokens, resolveModelGroupCandidates, type RouteResult, type ChainRow } from '../services/router.js';
import { getDb } from '../db/index.js';
import { resolveAuth, prependSystemPrompt } from '../lib/system-prompt.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdForDispatch } from '../services/model-groups.js';
import { contentToString, messageHasImage } from '../lib/content.js';
import { normalizeMessageImages } from '../lib/image-normalize.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { invalidToolArgumentsError, invalidToolCallReasons, isToolArgumentValidationEnabled } from '../lib/tool-validate.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import {
  extractApiToken,
  getRequestGroupId,
  getStickyModel,
  setStickyModel,
  streamReasoningText,
  completionReasoningText,
  traceRouteEvent,
  logRequest,
} from './proxy.js';
import { runFallbackLoop, newFallbackState, recordUpstreamSuccess, setFallbackHeaders, exhaustionErrorPayload, setExhaustionHeaders, type AttemptRecord } from '../lib/fallback-loop.js';
import { routedViaValue } from '../lib/header-value.js';
import { applyTokenBudget, tokenBudgetMessage } from '../lib/guardrails.js';
import { samplingParamSchemaFields, pickSamplingParams, type ResponseFormat } from '../lib/sampling-params.js';
import { enforceJsonContent } from '../lib/structured-output.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { isClientAbortError, newClientAbortError, newHedgeAbortError } from '../lib/error-classify.js';
import { inferQuotaPoolKey, type QuotaObservationContext } from '../services/provider-quota.js';
import { compressRequest, formatCompressionHeader } from '../services/compression/pipeline.js';

export const responsesRouter = Router();

const AUTO_MODEL_ID = 'auto';

function isAutoModel(modelId: string | undefined): boolean {
  if (!modelId) return true;
  const lower = modelId.toLowerCase();
  return lower === AUTO_MODEL_ID || lower.startsWith(`${AUTO_MODEL_ID}:`);
}

// ─────────────────────────────────────────────────────────────────────────
// OpenAI Responses API shim (POST /v1/responses).
//
// Current Codex versions only speak the Responses API — `wire_api = "chat"`
// is rejected — so the existing /v1/chat/completions endpoint isn't reachable
// from Codex (see issue #96). This endpoint accepts a Responses-shaped request,
// translates it to the internal chat-message format, runs it through the SAME
// shared fallback loop as the proxy (lib/fallback-loop.ts), and translates the
// result back into the Responses object / SSE event stream Codex expects.
//
// A thin adapter: the cooldown/skip/penalty/exhaustion machinery is shared, and
// only the Responses request/stream translation lives here. This is what fixed
// the drift where /v1/responses ignored a provider Retry-After and under-benched
// a 403 (both are now handled identically to /chat/completions by the shared
// loop) and committed the SSE skeleton on the first raw chunk (the commit point
// is now held until the first meaningful content, so a pre-content failure fails
// over invisibly).
// ─────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 20;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Request schema ──────────────────────────────────────────────────────
// Lenient on purpose: the Responses API surface is large and evolving, and we
// only consume the fields we can map. Unknown fields (store, reasoning,
// metadata, previous_response_id, …) are accepted and ignored.

const contentPartSchema = z.object({ type: z.string() }).passthrough();

const messageItemSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});

const functionCallItemSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  id: z.string().optional(),
});

const functionCallOutputItemSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.union([z.string(), z.array(contentPartSchema), z.record(z.string(), z.unknown())]),
});

// Remaining official ResponseInputItemParam kinds. Codex computer-use round-trips
// `computer_call` (the model's action request) and `computer_call_output` (the
// harness's result, incl. screenshots); multi-turn sessions also replay
// `reasoning` / `local_shell_call` items. We accept them all so validation never
// 400s on a standard payload; each is then either mapped (below) or dropped
// because chat-completions upstreams have no equivalent (computer/local_shell).
// Each schema is permissive — we only consume the fields that matter.
const computerCallItemSchema = z.object({
  type: z.literal('computer_call'),
  call_id: z.string(),
  action: z.record(z.string(), z.unknown()).optional(),
  id: z.string().optional(),
}).passthrough();

const computerCallOutputItemSchema = z.object({
  type: z.literal('computer_call_output'),
  call_id: z.string(),
  output: z.union([
    z.string(),
    z.array(contentPartSchema),
    z.record(z.string(), z.unknown()),
  ]).optional(),
  id: z.string().optional(),
}).passthrough();

const reasoningItemSchema = z.object({
  type: z.literal('reasoning'),
  summary: z.union([z.string(), z.array(contentPartSchema)]).optional(),
  content: z.union([z.string(), z.array(contentPartSchema)]).optional(),
  id: z.string().optional(),
}).passthrough();

const localShellCallItemSchema = z.object({
  type: z.literal('local_shell_call'),
  call_id: z.string().optional(),
  action: z.record(z.string(), z.unknown()).optional(),
  id: z.string().optional(),
}).passthrough();

// The rest of the official ResponseInputItemParam union: built-in tool calls
// (web_search, file_search, code interpreter, image generation), MCP items,
// and item references. None has a chat-completions equivalent — validated
// loosely so a standard replay never 400s, then skipped at conversion like
// the kinds above.
const otherKnownItemSchema = z.object({
  type: z.enum([
    'web_search_call', 'file_search_call', 'code_interpreter_call',
    'image_generation_call', 'mcp_call', 'mcp_list_tools',
    'mcp_approval_request', 'mcp_approval_response', 'item_reference',
  ]),
  id: z.string().optional(),
}).passthrough();

const inputItemSchema = z.union([
  functionCallItemSchema,
  functionCallOutputItemSchema,
  computerCallItemSchema,
  computerCallOutputItemSchema,
  reasoningItemSchema,
  localShellCallItemSchema,
  otherKnownItemSchema,
  messageItemSchema,
]);

// Accept ANY tool type, not just 'function'. Codex (Responses API) sends
// built-in tools like `web_search` / `local_shell` alongside function tools;
// a strict z.literal('function') rejected the whole request. We validate
// loosely here and drop non-function tools at conversion (toChatTools), since
// chat-completions providers only accept type:'function'.
const responsesToolSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).nullable().optional(),
  strict: z.boolean().nullable().optional(),
}).passthrough();

const responsesRequestSchema = z.object({
  model: z.string().optional(),
  instructions: z.string().nullable().optional(),
  input: z.union([z.string(), z.array(inputItemSchema)]),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  top_p: z.number().min(0).max(1).nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  tools: z.array(responsesToolSchema).optional(),
  tool_choice: z.union([
    z.enum(['none', 'auto', 'required']),
    z.object({ type: z.literal('function'), name: z.string() }).passthrough(),
  ]).optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  // Extended sampling params, validated the same way as /chat/completions.
  // Responses clients express structured output as `text.format` rather than
  // `response_format` — mapped where completionOpts is built.
  ...samplingParamSchemaFields,
  text: z.object({
    format: z.object({
      type: z.enum(['text', 'json_object', 'json_schema']),
      name: z.string().optional(),
      strict: z.boolean().nullable().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
    }).passthrough().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

// Responses content parts → plain text. input_text / output_text both carry
// `text`; other part types (images, etc.) are dropped (parity with the proxy).
function partsToString(content: string | Array<{ type: string; text?: unknown }>): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('');
}

// Responses content parts → internal chat content. Text parts map to text
// blocks, image parts (Responses `input_image`, chat-style `image_url`/`image`,
// and computer-use `computer_screenshot`) map to `image_url` blocks so vision
// routing and the provider adapters see them (parity with /chat/completions).
// `refusal` parts (assistant history replay) fold into text so the turn isn't
// silently emptied. All-text content collapses back to a plain string (the
// shape upstream chat providers and compression expect); an array comes back
// only once a message actually carries an image.
function partsToChatContent(content: string | Array<{ type: string; [k: string]: unknown }>): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> {
  if (typeof content === 'string') return content;
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> = [];
  for (const p of content) {
    const type = p.type;
    const text = p.text;
    if (type === 'text' || type === 'input_text' || type === 'output_text' || type === 'summary_text' || (type === undefined && typeof text === 'string')) {
      if (typeof text === 'string') blocks.push({ type: 'text', text });
      continue;
    }
    if (type === 'refusal') {
      // The model's refusal text on a replayed assistant turn; chat providers
      // have no refusal concept, so carry it as ordinary text.
      const refusal = (p as { refusal?: unknown }).refusal;
      if (typeof refusal === 'string') blocks.push({ type: 'text', text: refusal });
      continue;
    }
    if (type === 'input_image' || type === 'computer_screenshot' || type === 'image_url' || type === 'image') {
      // The image lives under `image_url`, as a bare data URL string
      // (Responses `input_image` / `computer_screenshot`) or as
      // `{ url }` (chat-style `image_url`). The Responses `detail` hint
      // (low/high/auto/original) rides along; adapters without an equivalent
      // (Gemini inlineData) ignore it. Unresolvable shapes (missing/empty
      // url, file_id-only) are rejected up front by the route's pre-check,
      // so dropping here never answers blind.
      const url = extractPartImageUrl(p);
      if (url) {
        const detail = (p as { detail?: unknown }).detail;
        blocks.push({ type: 'image_url', image_url: { url, ...(typeof detail === 'string' ? { detail } : {}) } });
      }
      continue;
    }
  }
  if (blocks.every((b) => b.type === 'text')) {
    return blocks.map((b) => (b as { type: 'text'; text: string }).text).join('');
  }
  return blocks;
}

// Shared url extraction so the translation and the pre-check below always
// agree on what counts as a resolvable image.
function extractPartImageUrl(p: { [k: string]: unknown }): string | undefined {
  const raw = p.image_url;
  const url = typeof raw === 'string' ? raw : (raw as { url?: unknown } | undefined)?.url;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

// Responses `input_image` references an image by `image_url` OR a Files API
// `file_id`. This proxy has no OpenAI Files backend, and the schema is
// deliberately lenient, so an image part with no resolvable url (file_id-only,
// or no url at all) can't survive translation — reject up front instead of
// silently dropping it and answering blind to an image the client believes
// was sent. (`computer_screenshot` shares these forms but is intentionally
// not checked: computer use is rejected wholesale up front, today and until
// it's a supported feature.)
export function responsesInputHasFileIdImage(req: ResponsesRequest): boolean {
  if (typeof req.input === 'string') return false;
  return req.input.some((item) => {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.some((p) => {
      const part = p as { type?: string; [k: string]: unknown };
      if (part.type !== 'input_image') return false;
      return extractPartImageUrl(part) === undefined;
    });
  });
}

// Computer use (the Responses `computer` / `computer_use_preview` tool + its
// computer_call/computer_call_output items) has no chat-completions equivalent:
// the harness loop needs the model's computer_actions and screenshot context,
// neither of which survives translation. Fail clearly (mirroring the image 422)
// rather than silently dropping the calls and breaking the tool loop.
export function responsesInputRequestsComputerUse(req: ResponsesRequest): boolean {
  if ((req.tools ?? []).some((t) => t.type === 'computer' || t.type === 'computer_use_preview')) return true;
  if (typeof req.input === 'string' || req.input == null) return false;
  return req.input.some((item) => {
    const type = (item as { type?: string })?.type;
    return type === 'computer_call' || type === 'computer_call_output';
  });
}

// ── Translate a Responses request → internal chat messages + options ──────
export function toChatMessages(req: ResponsesRequest): ChatMessage[] {
  const systemMessages: ChatMessage[] = [];

  if (req.instructions) {
    systemMessages.push({ role: 'system', content: req.instructions });
  }

  if (typeof req.input === 'string') {
    const messages = [{ role: 'user' as const, content: req.input }];
    return [...systemMessages, ...messages];
  }

  const messages: ChatMessage[] = [];

  const items = req.input;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if ('type' in item && item.type === 'function_call') {
      // Parallel tool calls replay as consecutive standalone function_call
      // items (no preceding assistant message item). Fold the run into one
      // assistant turn, for the same reason as the message+function_call
      // merge below: consecutive assistant turns 400 on strict upstreams.
      const toolCalls: ChatToolCall[] = [];
      let j = i;
      while (j < items.length && (items[j] as { type?: string }).type === 'function_call') {
        const fc = items[j] as z.infer<typeof functionCallItemSchema>;
        toolCalls.push({
          id: fc.call_id,
          type: 'function',
          function: { name: fc.name, arguments: fc.arguments },
        });
        j++;
      }
      messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
      i = j - 1;
      continue;
    }

    if ('type' in item && item.type === 'function_call_output') {
      const output = typeof item.output === 'string'
        ? item.output
        : Array.isArray(item.output)
          ? partsToString(item.output as any)
          : JSON.stringify(item.output);
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
      continue;
    }

    if ('type' in item && item.type !== 'message') {
      // computer_call / computer_call_output / reasoning / local_shell_call:
      // no chat-message equivalent (the route 422s computer use up front).
      // Skip rather than mis-parse as a message item.
      continue;
    }

    // message item
    const m = item as z.infer<typeof messageItemSchema>;
    // 'developer' is the Responses-era system role.
    const role = m.role === 'developer' ? 'system' : m.role;
    const content = partsToChatContent(m.content);

    if (role === 'system') {
      // Hoist system/developer messages to the start of the conversation:
      // chat providers (Gemini, Claude, Mistral) reject a system message that
      // appears after a user turn. Codex history replay often emits developer
      // items mid-conversation.
      systemMessages.push({ role: 'system', content });
      continue;
    }

    if (role === 'assistant') {
      // A Responses assistant turn is a message item followed by its
      // function_call items. Merge them into a single chat assistant message
      // (content + tool_calls); emitting consecutive assistant turns makes
      // Gemini map them to consecutive model turns and strict upstreams
      // (Mistral/Cohere) 400. Drop empty assistant items — an empty turn means
      // nothing to a chat provider. (#96)
      const toolCalls: ChatToolCall[] = [];
      let j = i + 1;
      while (j < items.length && (items[j] as { type?: string }).type === 'function_call') {
        const fc = items[j] as z.infer<typeof functionCallItemSchema>;
        toolCalls.push({
          id: fc.call_id,
          type: 'function',
          function: { name: fc.name, arguments: fc.arguments },
        });
        j++;
      }
      if (toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: content.length > 0 ? content : null,
          tool_calls: toolCalls,
        });
        i = j - 1;
        continue;
      }
      if (content.length === 0) continue;
      messages.push({ role: 'assistant', content });
      continue;
    }

    messages.push({ role, content });
  }

  return [...systemMessages, ...messages];
}

export function toChatTools(tools?: ResponsesRequest['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  // Forward only function tools — chat-completions upstreams reject other
  // Responses-API tool types (web_search, local_shell, etc.). Codex sends those
  // extras alongside its function tools (shell/exec, apply_patch); dropping them
  // keeps the request valid without losing the tools that actually do the work.
  const fns = tools.filter((t): t is typeof t & { name: string } => t.type === 'function' && typeof t.name === 'string');
  if (!fns.length) return undefined;
  return fns.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.parameters ? { parameters: t.parameters } : {}),
      ...(t.strict != null ? { strict: t.strict } : {}),
    },
  }));
}

export function toChatToolChoice(tc?: ResponsesRequest['tool_choice']): ChatToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  return { type: 'function', function: { name: tc.name } };
}

function requestDeclaresToolUse(req: ResponsesRequest): boolean {
  return (req.tools?.length ?? 0) > 0 && req.tool_choice !== 'none';
}

// ── Build the final (non-stream) Responses object ─────────────────────────
export function buildResponseObject(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: ChatToolCall[];
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
}) {
  const output: any[] = [];
  if (opts.text.length > 0) {
    output.push({
      type: 'message',
      id: newId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: opts.text, annotations: [] }],
    });
  }
  for (const tc of opts.toolCalls) {
    output.push({
      type: 'function_call',
      id: newId('fc'),
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: 'completed',
    });
  }

  return {
    id: opts.id,
    object: 'response',
    created_at: nowUnix(),
    status: 'completed',
    model: opts.model,
    output,
    output_text: opts.text,
    usage: {
      input_tokens: opts.promptTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: opts.completionTokens,
      output_tokens_details: { reasoning_tokens: opts.reasoningTokens ?? 0 },
      total_tokens: opts.promptTokens + opts.completionTokens,
    },
  };
}

function quotaContextForRoute(route: RouteResult, endpoint: string): QuotaObservationContext {
  return {
    platform: route.platform as Platform,
    keyId: route.keyId,
    modelId: route.modelId,
    quotaPoolKey: inferQuotaPoolKey(route.platform as Platform, route.modelId),
    endpoint,
    origin: 'responses',
  };
}

responsesRouter.post('/responses', async (req: Request, res: Response) => {
  const start = Date.now();
  const requestGroupId = getRequestGroupId(req);
  res.setHeader('X-Request-ID', requestGroupId);

  // Same auth as the proxy (accepts Bearer or x-api-key): unified key, or a
  // client-profile key carrying a server-enforced system prompt (#411).
  const auth = resolveAuth(extractApiToken(req));
  if (!auth) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const parsed = responsesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const reqData = parsed.data;

  // Computer use can't survive the chat-completions translation either (no
  // computer tool, no screenshot context). Fail clearly instead of silently
  // dropping the calls and breaking Codex's computer-use tool loop.
  if (responsesInputRequestsComputerUse(reqData)) {
    res.status(422).json({
      error: {
        message: 'Computer use is not yet supported on /v1/responses (the computer / computer_use_preview tool and computer_call items have no chat-completions equivalent).',
        type: 'invalid_request_error',
        code: 'no_computer_use_model',
      },
    });
    return;
  }

  // Unresolvable image parts (file_id-only, or no usable url) can't survive
  // translation — fail clearly rather than dropping the image and answering
  // blind.
  if (responsesInputHasFileIdImage(reqData)) {
    res.status(422).json({
      error: {
        message: "This request contains an image part that can't be resolved: input_image needs an image_url (an https URL or a base64 data URL); Files API file_id references aren't supported by this proxy.",
        type: 'invalid_request_error',
        code: 'unsupported_image_input',
      },
    });
    return;
  }

  const stream = reqData.stream ?? false;
  let messages = toChatMessages(reqData);
  const tools = toChatTools(reqData.tools);
  // name → parameter schema, for repairing double-encoded tool arguments on
  // the way back out (see lib/tool-args.ts).
  const toolSchemas = toolSchemaMap(tools);
  const tool_choice = tools?.length ? toChatToolChoice(reqData.tool_choice) : undefined;
  // Responses-API structured output arrives as `text.format`; translate it to
  // the internal response_format shape (an explicit response_format on the
  // body, unusual for this surface but valid, wins).
  const samplingParams = pickSamplingParams(reqData);
  const textFormat = reqData.text?.format;
  if (!samplingParams.response_format && textFormat && textFormat.type !== 'text') {
    samplingParams.response_format = textFormat.type === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: textFormat.name, strict: textFormat.strict, schema: textFormat.schema } }
      : { type: 'json_object' } as ResponseFormat;
  }

  const completionOpts = {
    temperature: reqData.temperature ?? undefined,
    max_tokens: reqData.max_output_tokens ?? undefined,
    top_p: reqData.top_p ?? undefined,
    tools,
    tool_choice,
    parallel_tool_calls: reqData.parallel_tool_calls ?? undefined,
    ...samplingParams,
  };

  const hasCacheControl = typeof reqData.input !== 'string' && reqData.input.some(item => {
    const content = (item as { content?: unknown }).content;
    return Array.isArray(content)
      && content.some(block => block && typeof block === 'object' && 'cache_control' in block);
  });
  const compressionResult = compressRequest(messages, {
    header: req.headers['x-freellm-compress'],
    tools,
    cacheControlPrefixLength: hasCacheControl ? messages.length : 0,
  });
  messages = compressionResult.messages;
  res.setHeader('X-FreeLLM-Compress', formatCompressionHeader(compressionResult));

  // Server-enforced system prompt (#411): after compression so it is never
  // compressed away, first in the list so the caller's own instructions
  // (`instructions` / system input items) follow it and cannot override it.
  messages = prependSystemPrompt(messages, auth.systemPrompt);

  // Downscale over-threshold inline images before estimation/routing so the
  // token budget, payload limits, and upstream transfer all see the shrunk
  // bytes (see lib/image-normalize.ts). Mutates the image blocks in place.
  await normalizeMessageImages(messages);

  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
    0,
  );

  // Image requests must route to a vision-capable model (mirrors
  // /chat/completions, proxy.ts). Reject up front with a clear message when
  // none is enabled; when vision models are available, requireVision routing
  // skips text-only models — including a pinned/sticky one — and falls back to
  // a vision-capable peer (#118, #125). A rough per-image token cost keeps
  // budget routing from being skewed by content the text heuristic can't see.
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
  // Capped output reserve so a large max_output_tokens can't falsely exclude the
  // model pool (#470); input counts in full. Threaded to the router separately:
  // it is exact and must not be inflated by the context-window safety margin
  // (#956 review).
  const outputReserve = routingReserveTokens(reqData.max_output_tokens);
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + outputReserve;

  // Guardrail: per-request token budget (request_max_tokens_budget, default
  // off). A request with no max_output_tokens gets its output capped to the
  // budget remainder instead of a rejection.
  const budgetCheck = applyTokenBudget(estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE, completionOpts.max_tokens);
  if (budgetCheck.rejection) {
    res.status(413).json({
      error: { message: tokenBudgetMessage(budgetCheck.rejection), type: 'invalid_request_error', code: 'request_token_budget' },
    });
    return;
  }
  completionOpts.max_tokens = budgetCheck.maxTokens;
  // Optional client-managed session affinity (mirrors /chat/completions).
  const rawSessionId = req.headers['x-codex-session-id']
    ?? req.headers['session-id']
    ?? req.headers['x-session-id'];
  const sessionIdHeader = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  const requestedModelLabel = reqData.model ?? 'auto';

  // Explicit `model` field pins routing. If the catalog has no enabled row
  // matching the requested id, return 400 — silently auto-routing to a
  // different model would be surprising to Responses API clients.
  // Priority: explicit model > sticky session > auto routing.
  let preferredModel: number | undefined;
  let groupChain: ChainRow[] | undefined;

  if (isAutoModel(requestedModelLabel)) {
    preferredModel = resolveStickyPreference(getStickyModel(messages, sessionIdHeader));
  } else {
    const db = getDb();
    const resolved = isUnifyEnabled() ? resolveRequestedIdForDispatch(requestedModelLabel, getModelGroups()) : null;
    const members = resolved?.memberDbIds ?? null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members, resolved!.demotedDbIds);
      if (groupChain.length === 0) {
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        const reason = anyEnabled ? 'has no providers with an enabled key' : 'is disabled';
        res.status(400).json({
          error: {
            message: `Model '${requestedModelLabel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
      const sticky = getStickyModel(messages, sessionIdHeader, requestedModelLabel);
      preferredModel = (sticky != null && groupChain.some(r => r.model_db_id === sticky)) ? sticky : undefined;
    } else {
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModelLabel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModelLabel) as { id: number } | undefined;
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        res.status(400).json({
          error: {
            message: `Model '${requestedModelLabel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
    }
  }

  // Tool-bearing requests (the normal case for Codex/agent clients on this
  // endpoint) must stay on models that emit structured tool_calls. Make the
  // routing decision from the original Responses payload, not the subset of
  // function tools we can forward to chat providers, because Codex may include
  // built-in tool descriptors alongside or instead of function descriptors.
  const wantsTools = requestDeclaresToolUse(reqData);
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

  const responseId = newId('resp');
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
  const dispatchOpts = { ...completionOpts, signal: AbortSignal.any([clientAbort.signal, hedgeAbort.signal]) };

  // Stream bookkeeping (used only when stream === true). `streamStarted` is the
  // commit flag: true once the response.created/in_progress skeleton has left,
  // after which failover is no longer possible. seq/streamStarted span attempts
  // so the SSE sequence numbers stay monotonic and a committed stream can't be
  // re-committed by a later attempt.
  let seq = 0;
  let streamStarted = false;
  const sse = (event: string, payload: Record<string, unknown>) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify({ type: event, sequence_number: seq++, ...payload })}\n\n`);
  };

  await runFallbackLoop({
    maxRetries: MAX_RETRIES,
    state,
    attemptLog,
    clientGone: () => clientGone,
    abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
    route: () => routeRequest(estimatedTotal, state.skipKeys.size > 0 ? state.skipKeys : undefined, preferredModel, hasImage, wantsTools, state.skipModels.size > 0 ? state.skipModels : undefined, groupChain, completionOpts.response_format !== undefined, state.skipPlatforms.size > 0 ? state.skipPlatforms : undefined, outputReserve),
    dispatch: async (route, attempt, ctx) => {
      traceRouteEvent('Responses', {
        event: attempt === 0 ? 'start' : 'next',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        requestedModel: attempt === 0 ? requestedModelLabel : undefined,
      });
      if (stream) {
        // Every output item (message text + each function_call) claims the next
        // free index. OpenAI's streaming SDK indexes snapshot.output by
        // output_index, so indices MUST be dense & unique — reusing 0 for the
        // text item after a tool-call item had already taken it makes the SDK
        // crash on `snapshot.output[output_index]` (#96, Codex computer-use).
        let outputIndex = 0;
        let msgItemId: string | null = null;
        let msgText = '';
        // output_index of the open text item (valid while msgItemId !== null).
        let textOutputIndex = 0;
        // tool-call accumulator keyed by the provider's tool_call index
        const toolAcc = new Map<number, { outputIndex: number; itemId: string; callId: string; name: string; args: string }>();
        let totalOutputTokens = 0;
        // #764: thinking tokens are tracked separately so the final Response
        // object can report `output_tokens_details.reasoning_tokens` truthfully
        // instead of a hardcoded 0.
        let totalReasoningTokens = 0;
        // #764: ttfb = first token of ANY kind (content or reasoning), recorded
        // in the pump loop; commit() only backfills streams that never produced
        // one. This path previously logged no ttfb at all, so Analytics showed
        // a null speed for every /v1/responses turn.
        let ttfbMs: number | null = null;

        // Inline-dialect hold window (#231): first text is held until it
        // either matches a tool-call dialect marker (held to the end and
        // rescued into function_call items) or provably cannot (flushed and
        // streamed normally). Mirrors the /chat/completions stream loop.
        let dialectMode: 'undecided' | 'passthrough' | 'dialect' = 'undecided';
        let heldText = '';
        let upstreamFinish: string | null = null;

        // Commit point: headers + the response.created/in_progress skeleton go
        // out only when the first MEANINGFUL output item is about to be emitted
        // (converged with /chat/completions — responses previously committed on
        // the first raw chunk, even a role-only one). Until then a connect-time
        // error, an empty completion, or an unparseable dialect turn fails over
        // on the same connection with no bytes on the wire. Idempotent.
        const commit = () => {
          if (streamStarted) return;
          if (ttfbMs === null) ttfbMs = Date.now() - start;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
          setFallbackHeaders(res, attempt, attemptLog);
          const skeleton = {
            id: responseId, object: 'response', created_at: nowUnix(),
            status: 'in_progress', model: route.modelId, output: [], output_text: '',
          };
          sse('response.created', { response: skeleton });
          sse('response.in_progress', { response: skeleton });
          streamStarted = true;
          // Committed: the answer is on its way, so the retry budget must no
          // longer cancel this attempt (it could not fail over now anyway).
          ctx.disarmHedge();
        };

        // Open the text output item and stream `text` as its first delta.
        // The text item takes the next free output index (it is NOT always 0 —
        // when the model emits tool_calls first, the function_call items own
        // the low indices). Every later text delta/done must reference this
        // same index or the SDK snapshot lookup misroutes the deltas.
        const openTextItem = (text: string) => {
          commit();
          msgItemId = newId('msg');
          textOutputIndex = outputIndex++;
          sse('response.output_item.added', {
            output_index: textOutputIndex,
            item: { id: msgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          });
          sse('response.content_part.added', {
            item_id: msgItemId, output_index: textOutputIndex, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          if (text) {
            sse('response.output_text.delta', { item_id: msgItemId, output_index: textOutputIndex, content_index: 0, delta: text });
            msgText += text;
          }
        };

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey,
            messages,
            route.modelId,
            dispatchOpts,
            quotaContextForRoute(route, 'responses'),
          );

          for await (const chunk of gen) {
            if (clientGone) break; // client hung up: stop pulling; reader.cancel() aborts upstream
            // In-band upstream error frame ({"error":...} inside a 200 SSE
            // stream — observed live from Groq). Throwing hands it to the catch
            // below: pre-commit it fails over, post-commit it surfaces
            // response.failed.
            const anyChunk = chunk as Record<string, any>;
            if (anyChunk.error && !anyChunk.choices) {
              throw new Error(`in-band provider error from ${route.displayName}: ${anyChunk.error.message ?? 'provider error'}`);
            }

            const choice0 = chunk.choices?.[0];
            if (choice0?.finish_reason) upstreamFinish = choice0.finish_reason;
            const delta = choice0?.delta;
            if (!delta) continue;

            // Text deltas → output_text events on a single message item, after
            // the dialect hold window has decided the text is real prose.
            const text = delta.content ?? '';
            // #764: reasoning models stream thinking before the first answer
            // token — count that first token as ttfb so Analytics speed
            // reflects the real head-of-stream, and count thinking tokens as
            // real output consumption.
            const reasoning = streamReasoningText(chunk);
            if (ttfbMs === null && (text.length > 0 || reasoning.length > 0)) {
              ttfbMs = Date.now() - start;
            }
            if (text) {
              totalOutputTokens += Math.ceil((text.length + reasoning.length) / 4);
              if (reasoning.length > 0) totalReasoningTokens += Math.ceil(reasoning.length / 4);
              if (dialectMode === 'passthrough') {
                if (msgItemId === null) openTextItem('');
                sse('response.output_text.delta', {
                  item_id: msgItemId, output_index: textOutputIndex, content_index: 0, delta: text,
                });
                msgText += text;
              } else {
                heldText += text;
                if (dialectMode === 'undecided') {
                  const probe = heldText.trimStart();
                  if (startsWithDialectMarker(probe)) {
                    dialectMode = 'dialect';
                  } else if (!couldBecomeDialectMarker(probe) || heldText.length > 256) {
                    dialectMode = 'passthrough';
                    openTextItem(heldText);
                    heldText = '';
                  }
                }
              }
            } else if (reasoning.length > 0) {
              // #764: thinking-only chunk (no visible text yet) — count tokens.
              totalOutputTokens += Math.ceil(reasoning.length / 4);
              totalReasoningTokens += Math.ceil(reasoning.length / 4);
            }

            // Tool-call deltas → function_call item + argument deltas.
            for (const tc of delta.tool_calls ?? []) {
              const idx = (tc as any).index ?? 0;
              let acc = toolAcc.get(idx);
              if (!acc) {
                // First time we see this tool call: open a new output item.
                commit();
                if (msgItemId !== null && msgText.length > 0) {
                  // close the text item (at its own output index) before starting a function_call item
                  sse('response.output_text.done', { item_id: msgItemId, output_index: textOutputIndex, content_index: 0, text: msgText });
                  sse('response.content_part.done', { item_id: msgItemId, output_index: textOutputIndex, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
                  sse('response.output_item.done', { output_index: textOutputIndex, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
                  msgItemId = null;
                }
                acc = { outputIndex: outputIndex++, itemId: newId('fc'), callId: tc.id || newId('call'), name: tc.function?.name ?? '', args: '' };
                toolAcc.set(idx, acc);
                sse('response.output_item.added', {
                  output_index: acc.outputIndex,
                  item: { id: acc.itemId, type: 'function_call', status: 'in_progress', call_id: acc.callId, name: acc.name, arguments: '' },
                });
              }
              const argFrag = tc.function?.arguments ?? '';
              if (tc.function?.name && !acc.name) acc.name = tc.function.name;
              if (argFrag) {
                acc.args += argFrag;
                sse('response.function_call_arguments.delta', { item_id: acc.itemId, output_index: acc.outputIndex, delta: argFrag });
              }
            }
          }

          // Resolve the dialect hold window now that the full text is known.
          // Held text was never emitted, so a dead dialect turn can still fail
          // over on the same SSE stream (nothing has been committed yet).
          if (heldText.length > 0) {
            const rescue = (wantsTools && (dialectMode === 'dialect' || containsDialectMarker(heldText)))
              ? rescueInlineToolCalls(heldText, new Set((tools ?? []).map(t => t.function.name)))
              : { detected: false as const, calls: null, cleanText: heldText };
            if (rescue.detected && !rescue.calls) {
              // Unparseable dialect turn: throw so the shared loop cooldowns this
              // model+key and fails over (streamStarted is still false).
              throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${heldText.slice(0, 120)}`);
            }
            if (rescue.detected && rescue.calls) {
              // Rescued calls become function_call items, exactly as if the
              // provider had streamed them structurally.
              console.log(`[Responses] Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName}`);
              if (rescue.cleanText.length > 0 && msgItemId === null) openTextItem(rescue.cleanText);
              let rescuedIdx = 0;
              for (const c of rescue.calls) {
                const idx = 1000 + rescuedIdx++; // synthetic accumulator keys, past any provider index
                commit();
                const acc = {
                  outputIndex: outputIndex++,
                  itemId: newId('fc'), callId: newId('call'), name: c.name, args: c.arguments,
                };
                toolAcc.set(idx, acc);
                sse('response.output_item.added', {
                  output_index: acc.outputIndex,
                  item: { id: acc.itemId, type: 'function_call', status: 'in_progress', call_id: acc.callId, name: acc.name, arguments: '' },
                });
              }
            } else if (msgItemId === null) {
              // Plain short answer that never left the hold window (e.g. "Hi").
              openTextItem(heldText);
            }
            heldText = '';
          }

          // Empty completion — the provider returned 200 with no text AND no
          // tool calls. Seen in production from nemotron-3-super on ~65k-token
          // contexts: transport-level "success", zero usable output. Nothing has
          // been committed yet (the skeleton is lazy), so throwing lets the
          // shared loop fail over to the next model on the same SSE connection.
          if (msgText.length === 0 && toolAcc.size === 0) {
            // Disconnect before the commit point: the break above fired with
            // nothing accumulated — CLIENT behavior, not a provider failure.
            // Falling through to the empty-completion throw benched a healthy
            // model+key for 90s on every Ctrl-C during a reasoning model's
            // TTFB window.
            if (clientGone && !streamStarted) {
              console.log(`[Responses] client disconnected before first token from ${route.displayName} — dropping attempt without benching`);
              return 'committed';
            }
            // finish_reason 'length' = the model spent the whole output budget
            // on hidden reasoning before any visible text: fail over, but skip
            // the cooldown/penalty (not a provider-health signal).
            throw Object.assign(
              new Error(`empty completion from ${route.displayName}`),
              upstreamFinish === 'length' ? { skipBench: true } : {},
            );
          }

          // Finalize any open text item.
          if (msgItemId !== null) {
            sse('response.output_text.done', { item_id: msgItemId, output_index: textOutputIndex, content_index: 0, text: msgText });
            sse('response.content_part.done', { item_id: msgItemId, output_index: textOutputIndex, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
            sse('response.output_item.done', { output_index: textOutputIndex, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
          }
          // Finalize tool-call items. Arguments are repaired against the tool's
          // parameter schema at this point (after the full string accumulated):
          // models like GLM double-encode nested arrays/objects as strings, and
          // Codex hard-rejects the call ("invalid type: string, expected a
          // sequence"). Clients consume the *.done events / final response for
          // arguments, so repairing here covers the streamed path too.
          //
          // No schema verdict here, deliberately. This surface commits on the
          // FIRST tool-call delta (`commit()` above, where the function_call
          // item is opened) — the arguments are not complete until this point,
          // which is long after the skeleton and the item.added events have
          // left. A verdict here could only turn a delivered-but-invalid call
          // into a `response.failed` on a stream the client is already reading,
          // which is strictly worse. Wiring it would mean holding the
          // function_call item until its arguments finish, the way
          // /chat/completions buffers — a change to this route's commit point,
          // not to validation.
          const finalToolCalls: ChatToolCall[] = [];
          for (const acc of toolAcc.values()) {
            const repairedArgs = repairToolArguments(acc.args, toolSchemas.get(acc.name));
            sse('response.function_call_arguments.done', { item_id: acc.itemId, output_index: acc.outputIndex, arguments: repairedArgs });
            sse('response.output_item.done', { output_index: acc.outputIndex, item: { id: acc.itemId, type: 'function_call', status: 'completed', call_id: acc.callId, name: acc.name, arguments: repairedArgs } });
            finalToolCalls.push({ id: acc.callId, type: 'function', function: { name: acc.name, arguments: repairedArgs } });
          }

          const finalResponse = buildResponseObject({
            id: responseId, model: route.modelId, text: msgText,
            toolCalls: finalToolCalls, promptTokens: estimatedInputTokens, completionTokens: totalOutputTokens,
            reasoningTokens: totalReasoningTokens,
          });
          sse('response.completed', { response: finalResponse });
          res.end();

          recordUpstreamSuccess(route, estimatedInputTokens + totalOutputTokens);
          setStickyModel(messages, route.modelDbId, sessionIdHeader);
          traceRouteEvent('Responses', {
            event: 'ok',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            inputTokens: estimatedInputTokens,
            outputTokens: totalOutputTokens,
          });
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, ttfbMs);
          return 'done';
        } catch (streamErr: any) {
          // Client abort mid-stream: the pump's own `if (clientGone) break`
          // can lose the race against the fetch-signal rejection, so the
          // abort may surface here instead. Rethrow — the shared loop's
          // client-abort branch stops the ladder without benching or an
          // error log row (the socket is gone; nothing to render).
          if (isClientAbortError(streamErr)) throw streamErr;
          // A committed stream can't fail over (bytes already sent) — surface a
          // response.failed event honestly and stop. A pre-commit failure throws
          // through to the shared loop for cooldown + failover.
          if (streamStarted) {
            const safe = sanitizeProviderErrorMessage(streamErr.message);
            traceRouteEvent('Responses', {
              event: 'fail',
              requestId: requestGroupId,
              attempt,
              platform: route.platform,
              model: route.modelId,
              latencyMs: Date.now() - start,
              error: safe,
            });
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, safe, ttfbMs);
            sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } } });
            res.end();
            return 'committed';
          }
          throw streamErr;
        }
      }

      const result = await route.provider.chatCompletion(
        route.apiKey,
        messages,
        route.modelId,
        dispatchOpts,
        quotaContextForRoute(route, 'responses'),
      );

      const msg = result.choices[0]?.message;
      let text = contentToString(msg?.content ?? '');
      let toolCalls = (msg?.tool_calls ?? []).map((tc) => ({
        ...tc,
        function: { ...tc.function, arguments: repairToolArguments(tc.function.arguments, toolSchemas.get(tc.function.name)) },
      }));

      // Inline tool-call dialect rescue (#231) — see /chat/completions.
      if (wantsTools && toolCalls.length === 0 && text) {
        const rescue = rescueInlineToolCalls(text, new Set((tools ?? []).map(t => t.function.name)));
        if (rescue.detected) {
          if (!rescue.calls) {
            throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${text.slice(0, 120)}`);
          }
          console.log(`[Responses] Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName}`);
          toolCalls = rescue.calls.map((c, i) => ({
            id: `call_rescued_${i + 1}`,
            type: 'function' as const,
            function: { name: c.name, arguments: repairToolArguments(c.arguments, toolSchemas.get(c.name)) },
          }));
          text = rescue.cleanText;
        }
      }

      // Opt-in schema verdict on what the repair could not fix. Thrown before
      // anything is written, so the failover hop is invisible to the client.
      if (isToolArgumentValidationEnabled() && toolCalls.length > 0) {
        const invalid = invalidToolCallReasons(toolCalls, toolSchemas);
        if (invalid.length > 0) throw invalidToolArgumentsError(route.displayName, invalid);
      }

      const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
      // #764: include reasoning tokens (message.reasoning_content / reasoning)
      // in the chars/4 estimate so thinking models aren't undercounted when the
      // provider omits `usage`.
      const completionTokens = result.usage?.completion_tokens
        ?? Math.ceil((text.length + completionReasoningText(result).length) / 4);
      // #764: report reasoning_tokens truthfully — the provider's own count
      // when advertised, else the same chars/4 estimate of the thinking text.
      const reasoningTokens = result.usage?.completion_tokens_details?.reasoning_tokens
        ?? Math.ceil(completionReasoningText(result).length / 4);

      // Empty completion → fail over via the shared loop (see the streaming
      // path); finish_reason 'length' skips the cooldown/penalty.
      if (!text && toolCalls.length === 0) {
        throw Object.assign(
          new Error(`empty completion from ${route.displayName}`),
          result.choices[0]?.finish_reason === 'length' ? { skipBench: true } : {},
        );
      }

      // Structured-output enforcement — see /chat/completions. Heal fenced or
      // prose-wrapped JSON in place, fail over (skipBench + skipModelForRequest
      // — a sibling key would misbehave identically) when the model ignored the
      // requested format; finish_reason 'length' gets an honest "truncated"
      // class instead, since the JSON was cut off by max_tokens, not ignored.
      if (completionOpts.response_format && text && toolCalls.length === 0) {
        const enforced = enforceJsonContent(text);
        if (!enforced.ok) {
          const truncated = result.choices[0]?.finish_reason === 'length';
          throw Object.assign(
            new Error(truncated
              ? `truncated JSON from ${route.displayName} (finish_reason=length — raise max_tokens for this ${completionOpts.response_format.type} request)`
              : `${route.displayName} ignored response_format (returned non-JSON despite ${completionOpts.response_format.type})`),
            { skipBench: true, skipModelForRequest: true },
          );
        }
        if (enforced.healed) text = enforced.content;
      }

      // Usage fallback: a missing provider `usage` block used to record 0
      // tokens against the rate-limit ledger; promptTokens/completionTokens
      // above already carry the chars/4 estimate.
      recordUpstreamSuccess(route, result.usage?.total_tokens ?? (promptTokens + completionTokens));
      setStickyModel(messages, route.modelDbId, sessionIdHeader);

      res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
      setFallbackHeaders(res, attempt, attemptLog);
      res.json(buildResponseObject({
        id: responseId, model: route.modelId, text, toolCalls,
        promptTokens, completionTokens, reasoningTokens,
      }));

      traceRouteEvent('Responses', {
        event: 'ok',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: Date.now() - start,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null);
      return 'done';
    },
    logFailure: (route, err, attempt) => {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      traceRouteEvent('Responses', {
        event: 'fail',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: latency,
        error: safeError,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError);
    },
    onFatal: (route, err, attempt) => {
      setFallbackHeaders(res, attempt, attemptLog);
      res.status(502).json({ error: { message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`, type: 'provider_error' } });
    },
    onRoutingExhausted: (lastError, routeErr, exhaustion, info) => {
      if (streamStarted) {
        // Headers are already on the wire — the honest status/Retry-After can
        // only travel in the failed-event payload.
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: exhaustionErrorPayload(exhaustion) } });
        res.end();
      } else {
        setFallbackHeaders(res, info.attempts.length, info.attempts);
        setExhaustionHeaders(res, exhaustion);
        res.status(exhaustion.status).json({ error: exhaustionErrorPayload(exhaustion) });
      }
    },
    onExhausted: (exhaustion, info) => {
      // The streaming skeleton may already be on the wire — close the SSE stream
      // with a failed event instead of writing JSON onto a committed response.
      if (streamStarted) {
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: exhaustionErrorPayload(exhaustion) } });
        res.end();
      } else {
        setFallbackHeaders(res, info.attempts.length, info.attempts);
        setExhaustionHeaders(res, exhaustion);
        res.status(exhaustion.status).json({ error: exhaustionErrorPayload(exhaustion) });
      }
    },
  });
});
