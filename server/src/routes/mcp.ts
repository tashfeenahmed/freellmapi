import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import { buildModelListing } from '../services/model-listing.js';
import { supportedParametersForPlatforms } from '../lib/sampling-params.js';
import { getRoutingScores, getRoutingStrategy, setRoutingStrategy } from '../services/router.js';
import type { RoutingStrategy } from '../services/scoring.js';
import { getCacheStats } from '../services/cache.js';

// ─────────────────────────────────────────────────────────────────────────
// MCP server for the gateway (POST /mcp) — Model Context Protocol over
// Streamable HTTP, stateless mode.
//
// Lets MCP-speaking agents (Claude Code, Cursor, Cline…) ask the router
// questions mid-session: which free models are usable right now and with
// which parameters, how healthy the provider pool is, what the routing
// strategy is, and how much quota the cache has saved — plus one control
// knob (switching the routing strategy). Inference itself stays on the
// OpenAI/Anthropic surfaces; these tools are the gateway's introspection.
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
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM request_hourly WHERE hour >= ?
  `).get(since.slice(0, 13) + ':00:00') as { requests: number; successes: number; input_tokens: number; output_tokens: number };
  const topModels = db.prepare(`
    SELECT platform, model_id, COUNT(*) AS requests,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes
    FROM requests WHERE created_at >= ?
    GROUP BY platform, model_id ORDER BY requests DESC LIMIT 5
  `).all(since) as Array<{ platform: string; model_id: string; requests: number; successes: number }>;
  return {
    range,
    requests: totals.requests,
    success_rate: totals.requests > 0 ? Math.round((totals.successes / totals.requests) * 1000) / 10 : null,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    top_models: topModels,
  };
}

function routingInfo(): unknown {
  const scores = getRoutingScores();
  return {
    strategy: scores.strategy,
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

// ── Tool registry ────────────────────────────────────────────────────────

interface McpTool {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown;
}

const TOOLS: Record<string, McpTool> = {
  list_models: {
    description: 'List the models this FreeLLMAPI router can serve, with context windows, tool support, and the parameters each model honors (supported_parameters). Defaults to only models that are usable right now.',
    inputSchema: {
      type: 'object',
      properties: {
        available_only: { type: 'boolean', description: 'false to include models that are configured but not currently usable (no key, disabled)', default: true },
      },
    },
    run: listModels,
  },
  provider_health: {
    description: 'Per-provider key statuses (healthy/rate_limited/invalid/error/unknown), active cooldowns, and how many models each provider can serve right now.',
    inputSchema: { type: 'object', properties: {} },
    run: () => providerHealth(),
  },
  usage_summary: {
    description: 'Request/token totals, success rate, and the top models by traffic for a recent window.',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['24h', '7d', '30d'], default: '24h' },
      },
    },
    run: usageSummary,
  },
  routing_info: {
    description: 'The active routing strategy and the current top-scored models in the fallback chain.',
    inputSchema: { type: 'object', properties: {} },
    run: () => routingInfo(),
  },
  set_routing_strategy: {
    description: 'Switch the routing strategy (priority = manual chain order; balanced / smartest / fastest / reliable are scored presets; custom uses the saved weight vector).',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: [...ROUTING_STRATEGIES] },
      },
      required: ['strategy'],
    },
    run: setStrategy,
  },
  cache_stats: {
    description: 'Response-cache statistics: entries, total hits, and the prompt/completion tokens the cache has saved.',
    inputSchema: { type: 'object', properties: {} },
    run: () => getCacheStats(),
  },
};

// ── JSON-RPC dispatch ────────────────────────────────────────────────────

// Returns the JSON-RPC response for a request, or undefined for a
// notification. JSON-RPC 2.0 defines a notification as a message WITHOUT an
// `id` member (id:null is a — discouraged — request and gets a response);
// detecting notifications by the `notifications/` method prefix answered
// no-id requests and 202'd id-carrying notifications.
function handleRpc(msg: JsonRpcRequest): unknown | undefined {
  const isNotification = msg.id === undefined;
  const respond = (response: unknown) => (isNotification ? undefined : response);
  const id = msg.id ?? null;
  return respond(dispatchRpc(msg, id));
}

function dispatchRpc(msg: JsonRpcRequest, id: number | string | null): unknown {
  switch (msg.method) {
    case 'initialize': {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'freellmapi', version: '1.0.0' },
        instructions: 'FreeLLMAPI gateway introspection: list usable free models (with per-model supported_parameters), check provider/key health, read usage and cache stats, and switch the routing strategy. Inference goes through the OpenAI-compatible /v1 endpoints, not MCP.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
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
        return rpcResult(id, toolJson(tool.run(args)));
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

mcpRouter.post('/', (req: Request, res: Response) => {
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

  const response = handleRpc(body as JsonRpcRequest);
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
