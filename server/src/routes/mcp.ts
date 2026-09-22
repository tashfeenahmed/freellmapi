import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { getDb, getUnifiedApiKey, getSetting } from '../db/index.js';
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import { buildModelListing } from '../services/model-listing.js';
import { supportedParametersForPlatforms } from '../lib/sampling-params.js';
import { getRoutingScores, getRoutingStrategy, setRoutingStrategy } from '../services/router.js';
import type { RoutingStrategy } from '../services/scoring.js';
import { getCacheStats } from '../services/cache.js';
import { getCompressionStats } from '../services/compression/stats.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// MCP server for the gateway (POST /mcp) — Model Context Protocol over
// Streamable HTTP, stateless mode.
//
// Lets MCP-speaking agents (Claude Code, Cursor, Cline…) ask the router
// questions mid-session: which free models are usable right now and with
// which parameters, how healthy the provider pool is, what the routing
// strategy is, and how much quota the cache has saved — plus one control
// knob (switching the routing strategy). The ask_freellmapi tool also lets
// ChatGPT and other MCP clients run a non-streaming inference through the same
// /v1/chat/completions path as every OpenAI-compatible client.
//
// Hand-rolled JSON-RPC instead of the MCP SDK for the same reason the
// OpenAPI viewer is dependency-free (#482): the desktop bundle and the
// Node-20 CI matrix punish heavy/new dependencies, and a tools-only
// stateless MCP server is ~five methods of plain JSON-RPC. No sessions, no
// server-initiated streams (GET → 405), single JSON responses.
//
// Auth mirrors /v1: the unified API key as a Bearer token (or x-api-key).
// ─────────────────────────────────────────────────────────────────────────

export const mcpRouter = Router();

// Always negotiated to 2025-06-18: this transport rejects JSON-RPC batches,
// which the 2025-03-26 and 2024-11-05 revisions still allowed — echoing an
// older requested version while enforcing the newer transport rule promised
// clients batching they'd never get. Per the MCP spec the server answers with
// the latest version it supports; clients that can't speak it disconnect.
const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// One text block carrying pretty-printed JSON — the standard shape for
// machine-readable MCP tool output.
function toolJson(data: unknown) {
  const structuredContent = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : { result: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent,
  };
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ── Tool implementations ─────────────────────────────────────────────────

function listModels(args: Record<string, unknown>): unknown {
  const availableOnly = args.available_only !== false; // default true: agents want what they can use
  const { models, autoContextWindow } = buildModelListing();
  const rows = (availableOnly ? models.filter(m => m.available === 1) : models).map(m => ({
    id: m.id,
    name: m.name,
    context_window: m.contextWindow,
    available: m.available === 1,
    platforms: m.platforms,
    supports_tools: m.supportsTools,
    supported_parameters: supportedParametersForPlatforms(m.platforms, { tools: m.supportsTools }),
  }));
  return {
    auto: { id: 'auto', description: 'router picks the best available model', context_window: autoContextWindow },
    count: rows.length,
    models: rows,
  };
}

function providerHealth(): unknown {
  const db = getDb();
  const now = Date.now();
  const keys = db.prepare(`
    SELECT platform, status, COUNT(*) AS n
    FROM api_keys WHERE enabled = 1
    GROUP BY platform, status
  `).all() as Array<{ platform: string; status: string; n: number }>;
  const cooldowns = db.prepare(`
    SELECT platform, COUNT(*) AS n
    FROM rate_limit_cooldowns WHERE expires_at_ms > ?
    GROUP BY platform
  `).all(now) as Array<{ platform: string; n: number }>;
  const availableModels = db.prepare(`
    SELECT m.platform, COUNT(*) AS n
    FROM models m
    WHERE m.enabled = 1 AND EXISTS (
      SELECT 1 FROM api_keys k
      WHERE k.platform = m.platform AND k.enabled = 1
        AND (m.key_id IS NULL OR k.id = m.key_id)
    )
    GROUP BY m.platform
  `).all() as Array<{ platform: string; n: number }>;

  const byPlatform = new Map<string, { keys: Record<string, number>; active_cooldowns: number; available_models: number }>();
  const entry = (p: string) => {
    let e = byPlatform.get(p);
    if (!e) { e = { keys: {}, active_cooldowns: 0, available_models: 0 }; byPlatform.set(p, e); }
    return e;
  };
  for (const k of keys) entry(k.platform).keys[k.status] = k.n;
  for (const c of cooldowns) entry(c.platform).active_cooldowns = c.n;
  for (const m of availableModels) entry(m.platform).available_models = m.n;
  return Object.fromEntries([...byPlatform.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

const USAGE_RANGES: Record<string, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };

function usageSummary(args: Record<string, unknown>): unknown {
  // Object.hasOwn: a prototype key ('constructor', 'toString') is truthy via
  // the prototype chain but multiplies to NaN below — fall back to 24h.
  const range = typeof args.range === 'string' && Object.hasOwn(USAGE_RANGES, args.range) ? args.range : '24h';
  const db = getDb();
  // SQLite datetime('now') format (space separator, no ms/Z) — an ISO 'T'
  // string compares GREATER than every same-day stored row (space < 'T'
  // lexicographically), which silently dropped the window's boundary day:
  // "24h" effectively meant "since UTC midnight". Same conversion as
  // routes/analytics.ts.
  const since = new Date(Date.now() - USAGE_RANGES[range] * 3600_000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const totals = db.prepare(`
    SELECT COALESCE(SUM(total_requests), 0) AS requests,
           COALESCE(SUM(success_count), 0) AS successes,
           COALESCE(SUM(error_count), 0) AS errors,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM request_hourly WHERE hour >= ?
  `).get(since.slice(0, 13) + ':00:00') as { requests: number; successes: number; errors: number; input_tokens: number; output_tokens: number };
  const topModels = db.prepare(`
    SELECT platform, model_id, COUNT(*) AS requests,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes
    FROM requests WHERE created_at >= ?
    GROUP BY platform, model_id ORDER BY requests DESC LIMIT 5
  `).all(since) as Array<{ platform: string; model_id: string; requests: number; successes: number }>;
  return {
    range,
    requests: totals.requests,
    // Over success+error only: 'canceled' rows (#752) are neither.
    success_rate: totals.successes + totals.errors > 0 ? Math.round((totals.successes / (totals.successes + totals.errors)) * 1000) / 10 : null,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    top_models: topModels,
  };
}

function routingInfo(): unknown {
  const scores = getRoutingScores();
  return {
    strategy: scores.strategy,
    // Which key of a platform requests are steered to (#919) — a separate knob
    // from the model strategy, so it has to be reported separately too.
    key_selection: scores.keySelectionStrategy,
    top_models: scores.scores
      .filter(s => s.enabled)
      .slice(0, 10)
      .map(s => ({ model: s.modelId, platform: s.platform, score: Math.round(s.score * 1000) / 1000 })),
  };
}

const ROUTING_STRATEGIES = ['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom'] as const;

function setStrategy(args: Record<string, unknown>): unknown {
  const strategy = args.strategy;
  if (typeof strategy !== 'string' || !(ROUTING_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new Error(`strategy must be one of: ${ROUTING_STRATEGIES.join(', ')}`);
  }
  setRoutingStrategy(strategy as RoutingStrategy);
  return { strategy: getRoutingStrategy() };
}

const DEFAULT_MCP_INFERENCE_TIMEOUT_MS = 120_000;
const MAX_MCP_INFERENCE_TIMEOUT_MS = 300_000;

const askFreeLlmApiSchema = z.object({
  prompt: z.string().min(1).max(400_000),
  system: z.string().min(1).max(50_000).optional(),
  model: z.string().min(1).max(256).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(32_768).optional(),
  timeout_ms: z.number().int().min(1_000).max(MAX_MCP_INFERENCE_TIMEOUT_MS).optional(),
}).strict();

function mcpDefaultModel(): string {
  const configured = process.env.MCP_INFERENCE_DEFAULT_MODEL?.trim();
  if (!configured) return 'auto';
  if (configured.length > 256) {
    throw new Error('MCP_INFERENCE_DEFAULT_MODEL must be at most 256 characters');
  }
  return configured;
}

function mcpInferenceTimeoutMs(): number {
  const raw = process.env.MCP_INFERENCE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_MCP_INFERENCE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > MAX_MCP_INFERENCE_TIMEOUT_MS) {
    return DEFAULT_MCP_INFERENCE_TIMEOUT_MS;
  }
  return parsed;
}

function loopbackChatCompletionsUrl(req: Request): string {
  const port = req.socket.localPort;
  if (!port) throw new Error('Cannot determine the local FreeLLMAPI port for inference');

  let address = (req.socket.localAddress || '127.0.0.1').split('%')[0];
  if (address === '0.0.0.0') address = '127.0.0.1';
  if (address === '::') address = '::1';
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}/v1/chat/completions`;
}

function assistantText(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

async function askFreeLlmApi(args: Record<string, unknown>, req: Request, res: Response): Promise<unknown> {
  const parsed = askFreeLlmApiSchema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(error => `${error.path.join('.') || 'arguments'}: ${error.message}`)
      .slice(0, 5)
      .join(', ');
    throw new Error(`Invalid ask_freellmapi arguments: ${detail}`);
  }

  const input = parsed.data;
  const model = input.model?.trim() || mcpDefaultModel();
  const timeoutMs = input.timeout_ms ?? mcpInferenceTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortOnDisconnect = () => controller.abort();
  req.once('aborted', abortOnDisconnect);
  res.once('close', abortOnDisconnect);

  try {
    const messages = [
      ...(input.system ? [{ role: 'system', content: input.system }] : []),
      { role: 'user', content: input.prompt },
    ];
    const response = await fetch(loopbackChatCompletionsUrl(req), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${getUnifiedApiKey()}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.max_tokens === undefined ? {} : { max_tokens: input.max_tokens }),
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload: any;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`FreeLLMAPI inference returned non-JSON data (HTTP ${response.status})`);
    }

    if (!response.ok) {
      const upstreamMessage = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
      throw new Error(`FreeLLMAPI inference failed (${response.status}): ${sanitizeProviderErrorMessage(upstreamMessage)}`);
    }

    const answer = assistantText(payload);
    if (!answer) {
      throw new Error(`FreeLLMAPI inference returned no assistant text (finish_reason: ${payload?.choices?.[0]?.finish_reason ?? 'unknown'})`);
    }

    return {
      answer,
      requested_model: model,
      model: typeof payload?.model === 'string' ? payload.model : null,
      finish_reason: typeof payload?.choices?.[0]?.finish_reason === 'string'
        ? payload.choices[0].finish_reason
        : null,
      usage: payload?.usage && typeof payload.usage === 'object' ? payload.usage : null,
      routed_via: response.headers.get('x-routed-via'),
      fallback_trail: response.headers.get('x-fallback-trail'),
      cache: response.headers.get('x-freellm-cache'),
      compression: response.headers.get('x-freellm-compress'),
      execution_id: typeof payload?.execution_id === 'string'
        ? payload.execution_id
        : response.headers.get('x-request-id'),
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`FreeLLMAPI inference timed out or was cancelled after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    req.off('aborted', abortOnDisconnect);
    res.off('close', abortOnDisconnect);
  }
}

function healthcheck(): unknown {
  const { models } = buildModelListing();
  const availableModels = models.filter(model => model.available === 1).length;
  const providers = providerHealth() as Record<string, {
    keys: Record<string, number>;
    active_cooldowns: number;
    available_models: number;
  }>;
  const providerRows = Object.values(providers);
  const healthyProviders = providerRows.filter(provider =>
    (provider.keys.healthy ?? 0) > 0 && provider.available_models > 0,
  ).length;
  return {
    status: availableModels > 0 ? 'ready' : 'needs_configuration',
    mcp_enabled: isMcpServerEnabled(),
    default_model: mcpDefaultModel(),
    available_models: availableModels,
    configured_providers: providerRows.length,
    healthy_providers: healthyProviders,
    checked_at: new Date().toISOString(),
  };
}

// ── Tool registry ────────────────────────────────────────────────────────

interface McpTool {
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
  run: (args: Record<string, unknown>, req: Request, res: Response) => unknown | Promise<unknown>;
}

const READ_ONLY_LOCAL = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const TOOLS: Record<string, McpTool> = {
  ask_freellmapi: {
    title: 'Ask FreeLLMAPI',
    description: 'Use this when the user explicitly wants a FreeLLMAPI model to answer, analyze, rewrite, summarize, or generate text. Routes through the configured free-provider pool. Defaults to the server\'s MCP_INFERENCE_DEFAULT_MODEL (auto when unset). Returns the answer plus model, routing, cache, execution, and token-usage metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 400_000, description: 'The complete task or question for the selected FreeLLMAPI model.' },
        system: { type: 'string', minLength: 1, maxLength: 50_000, description: 'Optional system instructions for the FreeLLMAPI model.' },
        model: { type: 'string', minLength: 1, maxLength: 256, description: 'Model id, named chain, or auto. Omit to use MCP_INFERENCE_DEFAULT_MODEL.' },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        max_tokens: { type: 'integer', minimum: 1, maximum: 32_768 },
        timeout_ms: { type: 'integer', minimum: 1_000, maximum: MAX_MCP_INFERENCE_TIMEOUT_MS, description: 'Optional request timeout. Defaults to MCP_INFERENCE_TIMEOUT_MS or 120000.' },
      },
      required: ['prompt'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answer: { type: 'string' },
        requested_model: { type: 'string' },
        model: { type: ['string', 'null'] },
        finish_reason: { type: ['string', 'null'] },
        usage: { type: ['object', 'null'], additionalProperties: true },
        routed_via: { type: ['string', 'null'] },
        fallback_trail: { type: ['string', 'null'] },
        cache: { type: ['string', 'null'] },
        compression: { type: ['string', 'null'] },
        execution_id: { type: ['string', 'null'] },
      },
      required: ['answer', 'requested_model', 'model', 'finish_reason', 'usage', 'routed_via', 'fallback_trail', 'cache', 'compression', 'execution_id'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    run: (args, req, res) => askFreeLlmApi(args, req, res),
  },
  healthcheck: {
    title: 'Check FreeLLMAPI readiness',
    description: 'Check whether FreeLLMAPI is ready for ChatGPT calls, including MCP state, configured/healthy providers, available models, and the default MCP inference model. This does not spend provider quota.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY_LOCAL,
    run: () => healthcheck(),
  },
  list_models: {
    title: 'List FreeLLMAPI models',
    description: 'List the models this FreeLLMAPI router can serve, with context windows, tool support, and the parameters each model honors (supported_parameters). Defaults to only models that are usable right now.',
    inputSchema: {
      type: 'object',
      properties: {
        available_only: { type: 'boolean', description: 'false to include models that are configured but not currently usable (no key, disabled)', default: true },
      },
    },
    annotations: READ_ONLY_LOCAL,
    run: listModels,
  },
  provider_health: {
    title: 'Inspect provider health',
    description: 'Per-provider key statuses (healthy/rate_limited/invalid/error/unknown), active cooldowns, and how many models each provider can serve right now.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY_LOCAL,
    run: () => providerHealth(),
  },
  usage_summary: {
    title: 'Summarize FreeLLMAPI usage',
    description: 'Request/token totals, success rate, and the top models by traffic for a recent window.',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['24h', '7d', '30d'], default: '24h' },
      },
    },
    annotations: READ_ONLY_LOCAL,
    run: usageSummary,
  },
  routing_info: {
    title: 'Inspect model routing',
    description: 'The active routing strategy and the current top-scored models in the fallback chain.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY_LOCAL,
    run: () => routingInfo(),
  },
  set_routing_strategy: {
    title: 'Set model routing strategy',
    description: 'Switch the routing strategy (priority = manual chain order; balanced / smartest / fastest / reliable are scored presets; custom uses the saved weight vector).',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: [...ROUTING_STRATEGIES] },
      },
      required: ['strategy'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: setStrategy,
  },
  cache_stats: {
    title: 'Inspect response-cache savings',
    description: 'Response-cache statistics: entries, total hits, and the prompt/completion tokens the cache has saved.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY_LOCAL,
    run: () => getCacheStats(),
  },
  compression_stats: {
    title: 'Inspect prompt-compression savings',
    description: 'Prompt-compression statistics: requests compressed, estimated tokens saved, fidelity-gate discards, and per-engine savings.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY_LOCAL,
    run: () => getCompressionStats(),
  },
};

// ── JSON-RPC dispatch ────────────────────────────────────────────────────

// Returns the JSON-RPC response for a request, or undefined for a
// notification. JSON-RPC 2.0 defines a notification as a message WITHOUT an
// `id` member (id:null is a — discouraged — request and gets a response);
// detecting notifications by the `notifications/` method prefix answered
// no-id requests and 202'd id-carrying notifications.
async function handleRpc(msg: JsonRpcRequest, req: Request, res: Response): Promise<unknown | undefined> {
  const isNotification = msg.id === undefined;
  const respond = (response: unknown) => (isNotification ? undefined : response);
  const id = msg.id ?? null;
  return respond(await dispatchRpc(msg, id, req, res));
}

async function dispatchRpc(msg: JsonRpcRequest, id: number | string | null, req: Request, res: Response): Promise<unknown> {
  switch (msg.method) {
    case 'initialize': {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'freellmapi', version: '1.0.0' },
        instructions: 'Use ask_freellmapi when the user explicitly asks FreeLLMAPI or one of its models to perform a text task. Use healthcheck before troubleshooting availability; list_models for model choice; provider_health, usage_summary, cache_stats, compression_stats, and routing_info for diagnostics. set_routing_strategy changes server state.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
          annotations: t.annotations,
        })),
      });
    case 'tools/call': {
      const name = msg.params?.name as string;
      // Object.hasOwn: a bare index lookup resolves prototype members, so
      // name:"constructor"/"toString" passed the !tool check and died inside
      // the try as a confusing tool-level error instead of -32602.
      const tool = typeof name === 'string' && Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
        return rpcResult(id, toolJson(await tool.run(args, req, res)));
      } catch (err: any) {
        // Tool-level failures are results with isError, not protocol errors.
        return rpcResult(id, toolError(err?.message ?? 'tool failed'));
      }
    }
    default:
      // Known client notifications (notifications/initialized etc.) land here;
      // handleRpc drops the response for anything sent without an id, so they
      // are acked silently without special-casing the method name.
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

function authenticate(req: Request, res: Response): boolean {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    // Echo the request id when the body carries one, so strict JSON-RPC
    // clients can correlate the auth error with their pending call.
    const body = req.body;
    const id = body && typeof body === 'object' && !Array.isArray(body) && body.id !== undefined ? body.id : null;
    res.status(401).json(rpcError(id, -32001, 'Invalid API key. Authenticate with the unified key as a Bearer token.'));
    return false;
  }
  return true;
}

// ── Lifecycle configuration (#925, MVP-1) ───────────────────────────────────
// The MCP surface exposes provider health, usage stats and routing controls to
// anything holding the unified key, so it is a configured surface rather than
// an always-on one: /api/settings/enable-mcp (and the toggle on the Keys page)
// turns it on and off. The stored default is decided once, by migration:
// installs that already had provider keys when they upgraded keep it on, fresh
// installs start with it off.
export const MCP_ENABLED_SETTING = 'enable_mcp';

export function isMcpServerEnabled(): boolean {
  return getSetting(MCP_ENABLED_SETTING) === '1';
}

// Gate every verb, not just POST: a disabled server must not answer "405, POST
// instead" on GET/DELETE either. Runs before auth so a disabled server says so
// plainly, without hinting whether the presented key would have been valid, and
// reads the setting per request so the toggle applies without a restart.
mcpRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (isMcpServerEnabled()) {
    next();
    return;
  }
  const body = req.body;
  const id = body && typeof body === 'object' && !Array.isArray(body) && body.id !== undefined ? body.id : null;
  res.status(403).json(rpcError(id, -32000, 'MCP server is disabled. Turn it on from the dashboard (Keys -> Agent compatibility) or with PUT /api/settings/enable-mcp {"enabled":true}.'));
});

mcpRouter.post('/', async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  const body = req.body;
  // The 2025-06-18 revision removed JSON-RPC batching; a single message per
  // POST is the interoperable shape.
  if (Array.isArray(body)) {
    res.status(400).json(rpcError(null, -32600, 'Batch requests are not supported'));
    return;
  }
  if (!body || typeof body !== 'object' || typeof body.method !== 'string') {
    res.status(400).json(rpcError(null, -32600, 'Expected a JSON-RPC request object'));
    return;
  }

  const response = await handleRpc(body as JsonRpcRequest, req, res);
  if (response === undefined) {
    res.status(202).end(); // notification — accepted, nothing to say
    return;
  }
  res.json(response);
});

// Stateless server: no server-initiated stream, no sessions to delete.
mcpRouter.get('/', (_req: Request, res: Response) => {
  res.status(405).json(rpcError(null, -32000, 'This MCP server is stateless: POST JSON-RPC messages to /mcp.'));
});
mcpRouter.delete('/', (_req: Request, res: Response) => {
  res.status(405).json(rpcError(null, -32000, 'This MCP server is stateless: there is no session to delete.'));
});
