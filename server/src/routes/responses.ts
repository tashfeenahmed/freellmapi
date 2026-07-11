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
import { routeRequest, hasEnabledToolsModel, routingReserveTokens, type RouteResult } from '../services/router.js';
import { getUnifiedApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import {
  timingSafeStringEqual,
  extractApiToken,
  getRequestGroupId,
  getStickyModel,
  setStickyModel,
  traceRouteEvent,
  logRequest,
} from './proxy.js';
import { runFallbackLoop, newFallbackState, recordUpstreamSuccess } from '../lib/fallback-loop.js';
import { applyTokenBudget, tokenBudgetMessage } from '../lib/guardrails.js';
import { samplingParamSchemaFields, pickSamplingParams, type ResponseFormat } from '../lib/sampling-params.js';
import { enforceJsonContent } from '../lib/structured-output.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { inferQuotaPoolKey, type QuotaObservationContext } from '../services/provider-quota.js';

export const responsesRouter = Router();

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

const inputItemSchema = z.union([
  functionCallItemSchema,
  functionCallOutputItemSchema,
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

// Image input via the Responses API isn't carried through translation yet
// (partsToString flattens to text). Detect it so we can hard-fail with a clear
// pointer to /v1/chat/completions rather than silently dropping the image
// (#118, #125). Recognizes the Responses `input_image` part plus the
// chat-style `image_url` / `image` parts some clients reuse here.
export function responsesInputHasImage(req: ResponsesRequest): boolean {
  if (typeof req.input === 'string') return false;
  for (const item of req.input) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    if (content.some((p) => {
      const type = (p as { type?: string })?.type;
      return type === 'input_image' || type === 'image_url' || type === 'image';
    })) return true;
  }
  return false;
}

// ── Translate a Responses request → internal chat messages + options ──────
export function toChatMessages(req: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (req.instructions) {
    messages.push({ role: 'system', content: req.instructions });
  }

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input });
    return messages;
  }

  for (const item of req.input) {
    if ('type' in item && item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        }],
      });
    } else if ('type' in item && item.type === 'function_call_output') {
      const output = typeof item.output === 'string'
        ? item.output
        : Array.isArray(item.output)
          ? partsToString(item.output as any)
          : JSON.stringify(item.output);
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
    } else {
      // message item
      const m = item as z.infer<typeof messageItemSchema>;
      // 'developer' is the Responses-era system role.
      const role = m.role === 'developer' ? 'system' : m.role;
      messages.push({ role, content: partsToString(m.content) });
    }
  }

  return messages;
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
      output_tokens_details: { reasoning_tokens: 0 },
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

  // Same unified-key auth as the proxy (accepts Bearer or x-api-key).
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
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

  // Vision isn't carried through the Responses translation yet — fail clearly
  // instead of answering blind to a dropped image (#118, #125).
  if (responsesInputHasImage(reqData)) {
    res.status(422).json({
      error: {
        message: 'Image input is not yet supported on /v1/responses. Use /v1/chat/completions with an image_url content part instead.',
        type: 'invalid_request_error',
        code: 'no_vision_model',
      },
    });
    return;
  }

  const stream = reqData.stream ?? false;
  const messages = toChatMessages(reqData);
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

  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
    0,
  );
  // Capped output reserve so a large max_output_tokens can't falsely exclude the
  // model pool (#470); input counts in full.
  const estimatedTotal = estimatedInputTokens + routingReserveTokens(reqData.max_output_tokens);

  // Guardrail: per-request token budget (request_max_tokens_budget, default
  // off). A request with no max_output_tokens gets its output capped to the
  // budget remainder instead of a rejection.
  const budgetCheck = applyTokenBudget(estimatedInputTokens, completionOpts.max_tokens);
  if (budgetCheck.rejection) {
    res.status(413).json({
      error: { message: tokenBudgetMessage(budgetCheck.rejection), type: 'invalid_request_error', code: 'request_token_budget' },
    });
    return;
  }
  completionOpts.max_tokens = budgetCheck.maxTokens;
  // Optional client-managed session affinity (mirrors /chat/completions).
  const rawSessionId = req.headers['x-session-id'];
  const sessionIdHeader = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  const preferredModel = getStickyModel(messages, sessionIdHeader);
  const requestedModelLabel = reqData.model ?? 'auto';

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
    route: () => routeRequest(estimatedTotal, state.skipKeys.size > 0 ? state.skipKeys : undefined, preferredModel, false, wantsTools, state.skipModels.size > 0 ? state.skipModels : undefined, undefined, completionOpts.response_format !== undefined),
    dispatch: async (route, attempt) => {
      traceRouteEvent('Responses', {
        event: attempt === 0 ? 'start' : 'next',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        requestedModel: attempt === 0 ? requestedModelLabel : undefined,
      });
      if (stream) {
        let outputIndex = 0;
        let msgItemId: string | null = null;
        let msgText = '';
        // tool-call accumulator keyed by the provider's tool_call index
        const toolAcc = new Map<number, { outputIndex: number; itemId: string; callId: string; name: string; args: string }>();
        let totalOutputTokens = 0;

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
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
          const skeleton = {
            id: responseId, object: 'response', created_at: nowUnix(),
            status: 'in_progress', model: route.modelId, output: [], output_text: '',
          };
          sse('response.created', { response: skeleton });
          sse('response.in_progress', { response: skeleton });
          streamStarted = true;
        };

        // Open the text output item and stream `text` as its first delta.
        const openTextItem = (text: string) => {
          commit();
          msgItemId = newId('msg');
          sse('response.output_item.added', {
            output_index: outputIndex,
            item: { id: msgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          });
          sse('response.content_part.added', {
            item_id: msgItemId, output_index: outputIndex, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          if (text) {
            sse('response.output_text.delta', { item_id: msgItemId, output_index: outputIndex, content_index: 0, delta: text });
            msgText += text;
          }
        };

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey,
            messages,
            route.modelId,
            completionOpts,
            quotaContextForRoute(route, 'responses'),
          );

          for await (const chunk of gen) {
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
            if (text) {
              totalOutputTokens += Math.ceil(text.length / 4);
              if (dialectMode === 'passthrough') {
                if (msgItemId === null) openTextItem('');
                sse('response.output_text.delta', {
                  item_id: msgItemId, output_index: 0, content_index: 0, delta: text,
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
            }

            // Tool-call deltas → function_call item + argument deltas.
            for (const tc of delta.tool_calls ?? []) {
              const idx = (tc as any).index ?? 0;
              let acc = toolAcc.get(idx);
              if (!acc) {
                // First time we see this tool call: open a new output item.
                commit();
                if (msgItemId !== null && msgText.length > 0) {
                  // close the text item (always output index 0) before starting a function_call item
                  sse('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: msgText });
                  sse('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
                  sse('response.output_item.done', { output_index: 0, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
                  msgItemId = null;
                }
                outputIndex = toolAcc.size + (msgText.length > 0 ? 1 : 0);
                acc = { outputIndex, itemId: newId('fc'), callId: tc.id || newId('call'), name: tc.function?.name ?? '', args: '' };
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
            const rescue = (dialectMode === 'dialect' || containsDialectMarker(heldText))
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
                  outputIndex: toolAcc.size + (msgText.length > 0 ? 1 : 0),
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
            sse('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: msgText });
            sse('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
            sse('response.output_item.done', { output_index: 0, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
          }
          // Finalize tool-call items. Arguments are repaired against the tool's
          // parameter schema at this point (after the full string accumulated):
          // models like GLM double-encode nested arrays/objects as strings, and
          // Codex hard-rejects the call ("invalid type: string, expected a
          // sequence"). Clients consume the *.done events / final response for
          // arguments, so repairing here covers the streamed path too.
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
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);
          return 'done';
        } catch (streamErr: any) {
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
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, safe);
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
        completionOpts,
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
      const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
      const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);

      // Empty completion → fail over via the shared loop (see the streaming
      // path); finish_reason 'length' skips the cooldown/penalty.
      if (!text && toolCalls.length === 0) {
        throw Object.assign(
          new Error(`empty completion from ${route.displayName}`),
          result.choices[0]?.finish_reason === 'length' ? { skipBench: true } : {},
        );
      }

      // Structured-output enforcement — see /chat/completions. Heal fenced or
      // prose-wrapped JSON in place, fail over (skipBench) when the model
      // ignored the requested format outright.
      if (completionOpts.response_format && text && toolCalls.length === 0) {
        const enforced = enforceJsonContent(text);
        if (!enforced.ok) {
          throw Object.assign(
            new Error(`${route.displayName} ignored response_format (returned non-JSON despite ${completionOpts.response_format.type})`),
            { skipBench: true },
          );
        }
        if (enforced.healed) text = enforced.content;
      }

      // Usage fallback: a missing provider `usage` block used to record 0
      // tokens against the rate-limit ledger; promptTokens/completionTokens
      // above already carry the chars/4 estimate.
      recordUpstreamSuccess(route, result.usage?.total_tokens ?? (promptTokens + completionTokens));
      setStickyModel(messages, route.modelDbId, sessionIdHeader);

      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.json(buildResponseObject({
        id: responseId, model: route.modelId, text, toolCalls,
        promptTokens, completionTokens,
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
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.status(502).json({ error: { message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`, type: 'provider_error' } });
    },
    onRoutingExhausted: (lastError, routeErr, exhaustion, info) => {
      const status = exhaustion?.status ?? routeErr.status ?? 503;
      const message = exhaustion?.message ?? routeErr.message;
      const type = exhaustion?.type ?? 'routing_error';
      if (streamStarted) {
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message, type } } });
        res.end();
      } else {
        if (info.attempts.length > 0) res.setHeader('X-Fallback-Attempts', String(info.attempts.length));
        res.status(status).json({ error: { message, type } });
      }
    },
    onExhausted: (exhaustion, info) => {
      // The streaming skeleton may already be on the wire — close the SSE stream
      // with a failed event instead of writing JSON onto a committed response.
      if (streamStarted) {
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message: exhaustion.message, type: exhaustion.type } } });
        res.end();
      } else {
        if (info.attempts.length > 0) res.setHeader('X-Fallback-Attempts', String(info.attempts.length));
        res.status(exhaustion.status).json({ error: { message: exhaustion.message, type: exhaustion.type } });
      }
    },
  });
});
