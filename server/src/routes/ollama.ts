import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import { getSetting, getUnifiedApiKey } from '../db/index.js';
import { buildModelListing } from '../services/model-listing.js';
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import { runInboundChat, type InboundChatResult, type InboundChatWire } from '../lib/inbound-chat.js';
import { runEmbeddings, embeddingsRetryAfterSec, EmbeddingsError } from '../services/embeddings.js';
import { validateSession } from '../services/auth.js';

export const ollamaRouter = Router();

export type OllamaEmulationMode = 'off' | 'open-loopback' | 'key-required';

export function getOllamaEmulationMode(): OllamaEmulationMode {
  const stored = getSetting('ollama_emulation');
  return stored === 'open-loopback' || stored === 'key-required' ? stored : 'off';
}

export function isLoopback(req: Request): boolean {
  const isLoopbackAddress = (value: string | undefined) => {
    const address = value?.trim().replace(/^::ffff:/i, '');
    return address === '127.0.0.1' || address === '::1';
  };
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const forwarded = req.headers['x-forwarded-for'];
  const firstForwarded = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(',')[0];
  // A local reverse proxy is itself a loopback socket, but its first forwarded
  // hop may be remote. Refuse that request instead of silently widening
  // open-loopback mode through the proxy.
  return !firstForwarded || isLoopbackAddress(firstForwarded);
}

function authorize(req: Request, res: Response): boolean {
  if ((req as Request & { urlTokenAuthenticated?: boolean }).urlTokenAuthenticated) {
    return true;
  }
  const mode = getOllamaEmulationMode();
  if (mode === 'off') {
    res.status(404).json({ error: 'Ollama emulation is disabled' });
    return false;
  }
  if (mode === 'open-loopback') {
    if (isLoopback(req)) return true;
    res.status(403).json({
      error: 'Ollama open-loopback mode only accepts connections from this machine',
    });
    return false;
  }
  const token = extractApiToken(req);
  if (!token || !timingSafeStringEqual(token, getUnifiedApiKey())) {
    res.status(401).json({ error: 'Invalid API key' });
    return false;
  }
  return true;
}

// Ollama clients routinely configure `name:latest`; catalog ids carry no tag.
export function normalizeOllamaModel(name: string | undefined): string {
  const trimmed = name?.trim().replace(/:latest$/i, '');
  return trimmed || 'auto';
}

// Real Ollama only emits stop/length/load/unload; clients switch on it before
// reading tool_calls, so upstream finish reasons like "tool_calls" map to stop.
function ollamaDoneReason(finishReason: string | null | undefined): string {
  return finishReason === 'length' ? 'length' : 'stop';
}

// Epoch-0 renders as "55 years ago" in Ollama UIs; boot time is honest enough.
const CATALOG_MODIFIED_AT = new Date().toISOString();

function ollamaModel(model: ReturnType<typeof buildModelListing>['models'][number]) {
  return {
    name: model.id,
    model: model.id,
    modified_at: CATALOG_MODIFIED_AT,
    size: 0,
    digest: '',
    details: {
      parent_model: '',
      format: 'freellmapi',
      family: model.ownedBy,
      families: [model.ownedBy],
      parameter_size: 'remote',
      quantization_level: 'remote',
    },
  };
}

ollamaRouter.get('/api/tags', (req, res) => {
  if (!authorize(req, res)) return;
  const { models } = buildModelListing();
  // Ollama clients always pick an explicit model from this list, so advertise
  // `auto` and only models /api/chat will actually accept (see proxy.ts /v1/models).
  const auto = {
    name: 'auto',
    model: 'auto',
    modified_at: CATALOG_MODIFIED_AT,
    size: 0,
    digest: '',
    details: {
      parent_model: '',
      format: 'freellmapi',
      family: 'freellmapi',
      families: ['freellmapi'],
      parameter_size: 'remote',
      quantization_level: 'remote',
    },
  };
  res.json({ models: [auto, ...models.filter(model => model.available === 1).map(ollamaModel)] });
});

ollamaRouter.get('/api/version', (req, res) => {
  if (!authorize(req, res)) return;
  // Plain semver: a prerelease suffix would compare BELOW 0.9.9 for clients
  // that gate features on a minimum Ollama version.
  res.json({ version: '0.9.9' });
});

const showSchema = z.object({ model: z.string().optional(), name: z.string().optional() }).passthrough();
ollamaRouter.post('/api/show', (req, res) => {
  if (!authorize(req, res)) return;
  const parsed = showSchema.safeParse(req.body);
  if (!parsed.success || !(parsed.data.model || parsed.data.name)) {
    res.status(400).json({ error: 'model is required' });
    return;
  }
  const id = normalizeOllamaModel(parsed.data.model || parsed.data.name);
  const { models, autoContextWindow } = buildModelListing();
  if (id === 'auto') {
    // /api/tags advertises `auto`, and clients probe /api/show for
    // capabilities before using a model.
    res.json({
      license: '',
      modified_at: CATALOG_MODIFIED_AT,
      modelfile: 'FROM auto',
      parameters: `num_ctx ${autoContextWindow ?? 128000}`,
      template: '{{ .Prompt }}',
      details: {
        parent_model: '',
        format: 'freellmapi',
        family: 'freellmapi',
        families: ['freellmapi'],
        parameter_size: 'remote',
        quantization_level: 'remote',
      },
      model_info: {
        'general.architecture': 'freellmapi',
        'general.context_length': autoContextWindow ?? 128000,
      },
      capabilities: ['completion', 'tools'],
    });
    return;
  }
  const model = models.find(entry => entry.id === id);
  if (!model) {
    res.status(404).json({ error: `model '${id}' not found` });
    return;
  }
  res.json({
    license: '',
    modified_at: CATALOG_MODIFIED_AT,
    modelfile: `FROM ${model.id}`,
    parameters: `num_ctx ${model.contextWindow ?? 128000}`,
    template: '{{ .Prompt }}',
    details: ollamaModel(model).details,
    model_info: {
      'general.architecture': model.ownedBy,
      'general.context_length': model.contextWindow ?? 128000,
    },
    capabilities: model.supportsTools
      ? ['completion', 'tools']
      : ['completion'],
  });
});

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.object({}).passthrough())]).optional(),
  tool_name: z.string().optional(),
  tool_calls: z.array(z.object({}).passthrough()).optional(),
}).passthrough();

const chatSchema = z.object({
  model: z.string().optional(),
  // Empty messages is a documented Ollama load/unload probe, not an error.
  messages: z.array(messageSchema).default([]),
  stream: z.boolean().optional(),
  tools: z.array(z.object({}).passthrough()).optional(),
  options: z.object({}).passthrough().optional(),
  format: z.union([z.literal('json'), z.record(z.string(), z.unknown())]).optional(),
}).passthrough();

function ollamaMessages(raw: z.infer<typeof messageSchema>[]): ChatMessage[] {
  const pendingCalls = new Map<string, string[]>();
  const converted: ChatMessage[] = [];
  raw.forEach((message, messageIndex) => {
    const toolCalls = message.tool_calls
      ?.filter((call: any) => call?.function?.name)
      .map((call: any, callIndex) => {
        const id = call.id || `call_${messageIndex}_${callIndex}`;
        const name = call.function.name as string;
        const queue = pendingCalls.get(name) ?? [];
        queue.push(id);
        pendingCalls.set(name, queue);
        return {
          id,
          type: 'function' as const,
          function: {
            name,
            arguments: typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments ?? {}),
          },
        };
      });
    let toolCallId: string | undefined;
    if (message.role === 'tool') {
      toolCallId = (message as any).tool_call_id;
      if (!toolCallId && message.tool_name) {
        toolCallId = pendingCalls.get(message.tool_name)?.shift();
      }
      if (!toolCallId) {
        const firstPending = [...pendingCalls.values()].find(queue => queue.length);
        toolCallId = firstPending?.shift() ?? `call_${messageIndex}`;
      }
    }
    // Ollama vision requests carry base64 images alongside text; convert them
    // to content blocks so vision-capable routing (hasImages) sees them.
    const images = (message as { images?: unknown }).images;
    const imageBlocks = Array.isArray(images)
      ? images
        .filter((image): image is string => typeof image === 'string' && image.length > 0)
        .map(image => ({
          type: 'image_url' as const,
          image_url: { url: image.startsWith('data:') ? image : `data:image/png;base64,${image}` },
        }))
      : [];
    const textContent = typeof message.content === 'string' ? message.content : '';
    converted.push({
      role: message.role,
      content: imageBlocks.length
        ? [{ type: 'text', text: textContent }, ...imageBlocks]
        : message.content ?? '',
      ...(message.tool_name ? { name: message.tool_name } : {}),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    } as ChatMessage);
  });
  return converted;
}

function ollamaTools(raw: unknown[] | undefined): ChatToolDefinition[] | undefined {
  if (!raw?.length) return undefined;
  const tools = raw
    .filter((tool: any) => tool?.function?.name)
    .map((tool: any) => ({
      type: 'function' as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      },
    }));
  return tools.length ? tools : undefined;
}

function ollamaToolCalls(result: Pick<InboundChatResult, 'toolCalls'>) {
  return result.toolCalls.map(call => {
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      args = { value: call.function.arguments };
    }
    return {
      function: {
        name: call.function.name,
        arguments: args,
      },
    };
  });
}

// Rough nanosecond timings measured at the gateway: clients compute
// tokens/sec as eval_count / eval_duration and choke on zero/undefined.
function ollamaDurations(startedMs: number, promptTokens: number, completionTokens: number) {
  const totalNs = Math.max(1, Math.round((performance.now() - startedMs) * 1e6));
  const promptShare = promptTokens + completionTokens > 0
    ? promptTokens / (promptTokens + completionTokens)
    : 0.5;
  const promptNs = Math.max(1, Math.round(totalNs * promptShare * 0.2));
  return {
    total_duration: totalNs,
    load_duration: 0,
    prompt_eval_duration: promptNs,
    eval_duration: Math.max(1, totalNs - promptNs),
  };
}

function ollamaWire(model: string): InboundChatWire {
  const createdAt = () => new Date().toISOString();
  const startedMs = performance.now();
  return {
    sendError: (res, status, message) => res.status(status).json({ error: message }),
    sendNonStream: (res, result) => {
      res.json({
        model,
        created_at: createdAt(),
        message: {
          role: 'assistant',
          content: result.text,
          ...(result.reasoning ? { thinking: result.reasoning } : {}),
          ...(result.toolCalls.length ? { tool_calls: ollamaToolCalls(result) } : {}),
        },
        done: true,
        done_reason: ollamaDoneReason(result.finishReason),
        ...ollamaDurations(startedMs, result.promptTokens, result.completionTokens),
        prompt_eval_count: result.promptTokens,
        eval_count: result.completionTokens,
      });
    },
    startStream: (res) => {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache');
    },
    sendTextDelta: (res, _route, text) => {
      res.write(`${JSON.stringify({
        model,
        created_at: createdAt(),
        message: { role: 'assistant', content: text },
        done: false,
      })}\n`);
    },
    sendReasoningDelta: (res, _route, thinking) => {
      res.write(`${JSON.stringify({
        model,
        created_at: createdAt(),
        message: { role: 'assistant', content: '', thinking },
        done: false,
      })}\n`);
    },
    sendToolCalls: (res, _route, calls) => {
      res.write(`${JSON.stringify({
        model,
        created_at: createdAt(),
        message: {
          role: 'assistant',
          content: '',
          tool_calls: ollamaToolCalls({ toolCalls: calls }),
        },
        done: false,
      })}\n`);
    },
    finishStream: (res, result) => {
      res.write(`${JSON.stringify({
        model,
        created_at: createdAt(),
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: ollamaDoneReason(result.finishReason),
        ...ollamaDurations(startedMs, result.promptTokens, result.completionTokens),
        prompt_eval_count: result.promptTokens,
        eval_count: result.completionTokens,
      })}\n`);
      res.end();
    },
    sendStreamError: (res, message) => {
      res.write(`${JSON.stringify({ error: message, done: true })}\n`);
    },
  };
}

// Every handler below RETURNS its promise rather than voiding it, so Express
// 5 forwards a rejection to errorHandler — the same treatment the OpenAI and
// Anthropic surfaces get from their `async` handlers. A voided promise leaves
// the router and resurfaces as an `unhandledRejection`, which the process
// safety net classifies as fatal for anything that is not a transport error,
// so one failing request exited the whole gateway instead of answering 500.
ollamaRouter.post('/api/chat', (req, res) => {
  if (!authorize(req, res)) return;
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `invalid request: ${parsed.error.message}` });
    return;
  }
  const body = parsed.data;
  const model = normalizeOllamaModel(body.model);
  if (body.messages.length === 0) {
    // Model load/unload probe: real Ollama answers immediately without
    // generating. Never burn upstream quota on it.
    const unload = (body as { keep_alive?: unknown }).keep_alive === 0;
    res.json({
      model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: unload ? 'unload' : 'load',
    });
    return;
  }
  const options = body.options as Record<string, unknown> | undefined;
  const rawSession = req.headers['x-ollama-session-id'] ?? req.headers['x-session-id'];
  const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;
  return runInboundChat(req, res, {
    model,
    messages: ollamaMessages(body.messages),
    stream: body.stream !== false,
    maxTokens: typeof options?.num_predict === 'number' ? options.num_predict : undefined,
    temperature: typeof options?.temperature === 'number' ? options.temperature : undefined,
    topP: typeof options?.top_p === 'number' ? options.top_p : undefined,
    topK: typeof options?.top_k === 'number' ? options.top_k : undefined,
    stop: Array.isArray(options?.stop)
      ? options.stop.filter((value): value is string => typeof value === 'string')
      : undefined,
    tools: ollamaTools(body.tools),
    responseFormat: body.format
      ? (body.format === 'json'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'ollama_response', schema: body.format } })
      : undefined,
    sessionId,
    endpoint: 'ollama/chat',
  }, ollamaWire(model));
});

const generateSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().default(''),
  system: z.string().optional(),
  suffix: z.string().optional(),
  stream: z.boolean().optional(),
  options: z.object({}).passthrough().optional(),
  format: z.union([z.literal('json'), z.record(z.string(), z.unknown())]).optional(),
}).passthrough();

function generateWire(model: string): InboundChatWire {
  const wire = ollamaWire(model);
  const startedMs = performance.now();
  return {
    ...wire,
    sendNonStream: (res, result) => {
      res.json({
        model,
        created_at: new Date().toISOString(),
        response: result.text,
        thinking: result.reasoning || undefined,
        done: true,
        done_reason: ollamaDoneReason(result.finishReason),
        // The gateway cannot produce real Ollama context tokens (an opaque
        // tokenizer artifact); an empty array keeps strict clients parsing.
        context: [],
        ...ollamaDurations(startedMs, result.promptTokens, result.completionTokens),
        prompt_eval_count: result.promptTokens,
        eval_count: result.completionTokens,
      });
    },
    sendTextDelta: (res, _route, text) => {
      res.write(`${JSON.stringify({
        model,
        created_at: new Date().toISOString(),
        response: text,
        done: false,
      })}\n`);
    },
    sendReasoningDelta: (res, _route, thinking) => {
      res.write(`${JSON.stringify({
        model,
        created_at: new Date().toISOString(),
        response: '',
        thinking,
        done: false,
      })}\n`);
    },
    // The inherited finisher emits a chat-shaped `message` frame; generate
    // consumers append `chunk.response` from every frame and strict parsers
    // reject the terminal frame without it.
    finishStream: (res, result) => {
      res.write(`${JSON.stringify({
        model,
        created_at: new Date().toISOString(),
        response: '',
        done: true,
        done_reason: ollamaDoneReason(result.finishReason),
        context: [],
        ...ollamaDurations(startedMs, result.promptTokens, result.completionTokens),
        prompt_eval_count: result.promptTokens,
        eval_count: result.completionTokens,
      })}\n`);
      res.end();
    },
  };
}

ollamaRouter.post('/api/generate', (req, res) => {
  if (!authorize(req, res)) return;
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `invalid request: ${parsed.error.message}` });
    return;
  }
  const body = parsed.data;
  const model = normalizeOllamaModel(body.model);
  if (!body.prompt && !body.suffix) {
    // Model load/unload probe; real Ollama answers without generating.
    const unload = (body as { keep_alive?: unknown }).keep_alive === 0;
    res.json({
      model,
      created_at: new Date().toISOString(),
      response: '',
      done: true,
      done_reason: unload ? 'unload' : 'load',
    });
    return;
  }
  const options = body.options as Record<string, unknown> | undefined;
  const messages: ChatMessage[] = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  messages.push({
    role: 'user',
    content: body.suffix
      ? `${body.prompt}\n\nComplete the text before this suffix:\n${body.suffix}`
      : body.prompt,
  });
  return runInboundChat(req, res, {
    model,
    messages,
    stream: body.stream !== false,
    maxTokens: typeof options?.num_predict === 'number' ? options.num_predict : undefined,
    temperature: typeof options?.temperature === 'number' ? options.temperature : undefined,
    topP: typeof options?.top_p === 'number' ? options.top_p : undefined,
    topK: typeof options?.top_k === 'number' ? options.top_k : undefined,
    responseFormat: body.format
      ? (body.format === 'json'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'ollama_response', schema: body.format } })
      : undefined,
    endpoint: 'ollama/generate',
  }, generateWire(model));
});

const embedSchema = z.object({
  model: z.string().optional(),
  // /api/embed sends `input`; the legacy /api/embeddings body — the whole
  // reason that endpoint exists — sends `prompt`.
  input: z.union([z.string(), z.array(z.string())]).optional(),
  prompt: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
}).passthrough().refine(data => data.input != null || data.prompt != null, {
  message: 'input is required',
});

async function handleEmbed(req: Request, res: Response, legacy: boolean): Promise<void> {
  if (!authorize(req, res)) return;
  const parsed = embedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `invalid request: ${parsed.error.message}` });
    return;
  }
  const rawInput = parsed.data.input ?? parsed.data.prompt ?? '';
  const inputs = Array.isArray(rawInput) ? rawInput : [rawInput];
  try {
    const result = await runEmbeddings(
      parsed.data.model?.replace(/:latest$/i, ''),
      inputs,
      parsed.data.dimensions,
    );
    if (legacy) {
      res.json({ embedding: result.vectors[0] ?? [] });
    } else {
      res.json({
        model: parsed.data.model || result.family,
        embeddings: result.vectors,
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: result.inputTokens,
      });
    }
  } catch (error: any) {
    const status = error instanceof EmbeddingsError ? error.status : 502;
    if (error instanceof EmbeddingsError) {
      const retrySec = embeddingsRetryAfterSec(error);
      if (retrySec !== undefined) res.setHeader('Retry-After', retrySec);
    }
    res.status(status).json({ error: error.message ?? 'embedding request failed' });
  }
}

ollamaRouter.post('/api/embed', (req, res) => {
  return handleEmbed(req, res, false);
});

// The dashboard already owns POST /api/embeddings. A valid dashboard session
// always falls through to that router; otherwise this exact path is Ollama's
// legacy embeddings endpoint and is governed by the emulation auth mode.
ollamaRouter.post('/api/embeddings', (req: Request, res: Response, next: NextFunction) => {
  const dashboardToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  if (validateSession(dashboardToken)) {
    next();
    return;
  }
  // A stale dashboard session must still surface as 401 so the SPA's
  // re-login flow triggers — unless the bearer could be a unified API key
  // for key-required Ollama mode, which handleEmbed will verify itself.
  if (dashboardToken && getOllamaEmulationMode() !== 'key-required') {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  return handleEmbed(req, res, true);
});
