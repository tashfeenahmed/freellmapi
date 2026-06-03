import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
} from '@freellmapi/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit } from '../services/ratelimit.js';
import { getUnifiedApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import {
  isRetryableError,
  timingSafeStringEqual,
  extractApiToken,
  getStickyModel,
  setStickyModel,
  logRequest,
} from './proxy.js';

export const responsesRouter = Router();

// ─────────────────────────────────────────────────────────────────────────
// OpenAI Responses API shim (POST /v1/responses).
//
// Current Codex versions only speak the Responses API — `wire_api = "chat"`
// is rejected — so the existing /v1/chat/completions endpoint isn't reachable
// from Codex (see issue #96). This endpoint accepts a Responses-shaped request,
// translates it to the internal chat-message format, runs it through the SAME
// router/retry machinery as the proxy, and translates the result back into the
// Responses object / SSE event stream that Codex expects.
//
// Deliberately self-contained: it duplicates the proxy's retry loop rather than
// refactoring that battle-tested handler, so the production /chat/completions
// path is untouched. Shared, side-effect-free helpers (routing, rate-limit
// bookkeeping, sticky sessions, logging) are imported, not re-implemented.
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

responsesRouter.post('/responses', async (req: Request, res: Response) => {
  const start = Date.now();

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
  const tool_choice = toChatToolChoice(reqData.tool_choice);
  const completionOpts = {
    temperature: reqData.temperature ?? undefined,
    max_tokens: reqData.max_output_tokens ?? undefined,
    top_p: reqData.top_p ?? undefined,
    tools,
    tool_choice,
    parallel_tool_calls: reqData.parallel_tool_calls ?? undefined,
  };

  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
    0,
  );
  const estimatedTotal = estimatedInputTokens + (reqData.max_output_tokens ?? 1000);
  const preferredModel = getStickyModel(messages);

  const responseId = newId('resp');
  const skipKeys = new Set<string>();
  let lastError: any = null;

  // Stream bookkeeping (used only when stream === true).
  let seq = 0;
  let streamStarted = false;
  const sse = (event: string, payload: Record<string, unknown>) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify({ type: event, sequence_number: seq++, ...payload })}\n\n`);
  };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel);
    } catch (err: any) {
      const status = lastError ? 429 : (err.status ?? 503);
      const message = lastError
        ? `All models rate-limited. Last error: ${lastError.message}`
        : err.message;
      const type = lastError ? 'rate_limit_error' : 'routing_error';
      if (streamStarted) {
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message, type } } });
        res.end();
      } else {
        res.status(status).json({ error: { message, type } });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // Headers + response.created on the first attempt that gets this far.
        if (!streamStarted) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          const skeleton = {
            id: responseId, object: 'response', created_at: nowUnix(),
            status: 'in_progress', model: route.modelId, output: [], output_text: '',
          };
          sse('response.created', { response: skeleton });
          sse('response.in_progress', { response: skeleton });
          streamStarted = true;
        }

        let outputIndex = 0;
        let msgItemId: string | null = null;
        let msgText = '';
        // tool-call accumulator keyed by the provider's tool_call index
        const toolAcc = new Map<number, { outputIndex: number; itemId: string; callId: string; name: string; args: string }>();
        let totalOutputTokens = 0;

        const gen = route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, completionOpts);

        for await (const chunk of gen) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          // Text deltas → output_text events on a single message item.
          const text = delta.content ?? '';
          if (text) {
            if (msgItemId === null) {
              msgItemId = newId('msg');
              sse('response.output_item.added', {
                output_index: outputIndex,
                item: { id: msgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
              });
              sse('response.content_part.added', {
                item_id: msgItemId, output_index: outputIndex, content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              });
            }
            sse('response.output_text.delta', {
              item_id: msgItemId, output_index: outputIndex, content_index: 0, delta: text,
            });
            msgText += text;
            totalOutputTokens += Math.ceil(text.length / 4);
          }

          // Tool-call deltas → function_call item + argument deltas.
          for (const tc of delta.tool_calls ?? []) {
            const idx = (tc as any).index ?? 0;
            let acc = toolAcc.get(idx);
            if (!acc) {
              // First time we see this tool call: open a new output item.
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

        // Finalize any open text item.
        if (msgItemId !== null) {
          sse('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: msgText });
          sse('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
          sse('response.output_item.done', { output_index: 0, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
        }
        // Finalize tool-call items.
        const finalToolCalls: ChatToolCall[] = [];
        for (const acc of toolAcc.values()) {
          sse('response.function_call_arguments.done', { item_id: acc.itemId, output_index: acc.outputIndex, arguments: acc.args });
          sse('response.output_item.done', { output_index: acc.outputIndex, item: { id: acc.itemId, type: 'function_call', status: 'completed', call_id: acc.callId, name: acc.name, arguments: acc.args } });
          finalToolCalls.push({ id: acc.callId, type: 'function', function: { name: acc.name, arguments: acc.args } });
        }

        const finalResponse = buildResponseObject({
          id: responseId, model: route.modelId, text: msgText,
          toolCalls: finalToolCalls, promptTokens: estimatedInputTokens, completionTokens: totalOutputTokens,
        });
        sse('response.completed', { response: finalResponse });
        res.end();

        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);
        return;
      } else {
        const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, completionOpts);

        const msg = result.choices[0]?.message;
        const text = contentToString(msg?.content ?? '');
        const toolCalls = msg?.tool_calls ?? [];
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);

        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? 0);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(buildResponseObject({
          id: responseId, model: route.modelId, text, toolCalls,
          promptTokens, completionTokens,
        }));

        logRequest(route.platform, route.modelId, route.keyId, 'success',
          promptTokens, completionTokens, Date.now() - start, null);
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, err.message);

      // Mid-stream failures can't be retried (bytes already sent) — close cleanly.
      if (stream && streamStarted) {
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } } });
        res.end();
        return;
      }

      if (isRetryableError(err)) {
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        continue;
      }

      res.status(502).json({ error: { message: `Provider error (${route.displayName}): ${err.message}`, type: 'provider_error' } });
      return;
    }
  }

  res.status(429).json({
    error: { message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`, type: 'rate_limit_error' },
  });
});
