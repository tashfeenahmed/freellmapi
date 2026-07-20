import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { routeRequest, resolveRequestedModel, resolveScopedChain, recordRateLimitHit, recordSuccess, hasEnabledVisionModel, hasEnabledToolsModel, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit, PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_FORBIDDEN_COOLDOWN_MS } from '../services/ratelimit.js';
import { getDb } from '../db/index.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { anthropicHasImage } from '../lib/anthropic-adapter.js';
import type { AnthropicMessageParam } from '@freellmapi/shared/anthropic-types.js';

export const anthropicRouter = Router();

// Reuse auth helpers from proxy.ts
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import { getUnifiedApiKey } from '../db/index.js';
import { getStickyModel, setStickyModel, isRetryableError, isModelNotFoundError, isModelAccessForbiddenError, isPaymentRequiredError } from './proxy.js';

const MAX_RETRIES = 20;

// ---- Zod schema ----

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string(),
  }),
});

const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.any())]).optional(),
  is_error: z.boolean().optional(),
});

const contentBlockSchema = z.union([
  textBlockSchema,
  imageBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
]);

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

const toolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.object({ type: z.literal('auto') }),
  z.object({ type: z.literal('any') }),
  z.object({ type: z.literal('tool'), name: z.string() }),
  z.object({ type: z.literal('none') }),
]);

const anthropicRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  system: z.union([z.string(), z.array(textBlockSchema)]).optional(),
  max_tokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  metadata: z.object({ user_id: z.string().optional() }).optional(),
});

// ---- Token estimation ----

function estimateTokens(msgs: z.infer<typeof messageSchema>[]): number {
  return msgs.reduce((sum, m) => {
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join(' ');
    return sum + Math.ceil(text.length / 4);
  }, 0);
}

// ---- /v1/messages endpoint ----

anthropicRouter.post('/messages', async (req: Request, res: Response) => {
  const start = Date.now();

  // Authenticate
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid API key' },
    });
    return;
  }

  // Log warning if anthropic-version is missing
  if (!req.headers['anthropic-version']) {
    console.warn('[anthropic] Missing anthropic-version header in request');
  }

  // Validate request body
  const parsed = anthropicRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    console.warn(`[anthropic] 400 invalid /messages request: ${detail}`);
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: `Invalid request: ${detail}` },
    });
    return;
  }

  const data = parsed.data;
  const requestedModel = data.model || 'auto';
  const stream = data.stream ?? false;

  // Cast to AnthropicMessageParam for downstream consumers
  const messages: AnthropicMessageParam[] = data.messages.map(m => ({
    role: m.role,
    content: m.content as AnthropicMessageParam['content'],
  }));

  // Image detection — must run BEFORE routing so we give a clear error
  // when no vision model is enabled rather than silently failing.
  const hasImage = anthropicHasImage(messages);
  if (hasImage && !hasEnabledVisionModel()) {
    res.status(422).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'This request includes an image, but no vision-capable model is enabled.',
      },
    });
    return;
  }

  // Tool detection — same early gate as vision above.
  const wantsTools = (data.tools?.length ?? 0) > 0;
  if (wantsTools && !hasEnabledToolsModel()) {
    res.status(422).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'This request includes tools, but no tool-capable model is enabled.',
      },
    });
    return;
  }

  // Token estimation
  const estimatedInputTokens = estimateTokens(messages);
  const imageCount = messages.reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'image').length : 0), 0);
  const IMAGE_TOKEN_ESTIMATE = 1000;
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + (data.max_tokens ?? 1000);

  // Sticky session key
  const rawSessionId = req.headers['x-session-id'];
  const sessionIdHeader = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

  // Resolve model - same intent parsing as /chat/completions (see proxy.ts):
  // auto -> sticky; scoped-level/scoped-alias -> prefetchedChain (503
  // scope_exhausted on exhaustion, no global fallback); pinned -> preferredModel.
  const requestedKind = resolveRequestedModel(requestedModel);
  let scopedChain: ReturnType<typeof resolveScopedChain> | undefined;
  let preferredModel: number | undefined;
  if (requestedKind.kind === 'auto') {
    preferredModel = getStickyModel(messages as any, sessionIdHeader);
  } else if (requestedKind.kind === 'scoped-level' || requestedKind.kind === 'scoped-alias') {
    scopedChain = resolveScopedChain(requestedKind);
    if (scopedChain.length === 0) {
      const scopeName = requestedKind.kind === 'scoped-level' ? `${requestedKind.level}-level` : requestedKind.aliasName;
      res.status(503).json({
        type: 'error',
        error: {
          type: 'scope_exhausted',
          message: `No enabled models in scope '${scopeName}'.`,
        },
      });
      return;
    }
  } else {
    const db = getDb();
    const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedKind.modelId) as { id: number } | undefined;
    if (enabled) {
      preferredModel = enabled.id;
    } else {
      const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedKind.modelId) as { id: number } | undefined;
      const reason = disabled ? 'is disabled' : 'is not in the catalog';
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `Model '${requestedKind.modelId}' ${reason}.`,
        },
      });
      return;
    }
  }

  const pinnedModelId = requestedKind.kind === 'pinned' ? requestedKind.modelId : null;

  // Retry loop
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, hasImage, wantsTools, skipModels.size > 0 ? skipModels : undefined, scopedChain);
    } catch (err: any) {
      // Scoped routing (level/alias) exhausted: 503 scope_exhausted, NOT 429.
      if (requestedKind.kind === 'scoped-level' || requestedKind.kind === 'scoped-alias') {
        const safeLastError = sanitizeProviderErrorMessage(lastError?.message ?? err.message);
        const scopeName = requestedKind.kind === 'scoped-level' ? `${requestedKind.level}-level` : requestedKind.aliasName;
        res.status(503).json({
          type: 'error',
          error: { type: 'scope_exhausted', message: `All models in scope '${scopeName}' exhausted. Last error: ${safeLastError}` },
        });
        return;
      }
      if (lastError) {
        const safeLastError = sanitizeProviderErrorMessage(lastError.message);
        res.status(429).json({
          type: 'error',
          error: { type: 'rate_limit_error', message: `All models rate-limited. Last error: ${safeLastError}` },
        });
      } else {
        res.status(err.status ?? 503).json({
          type: 'error',
          error: { type: 'api_error', message: err.message },
        });
      }
      return;
    }

    const messagesForProvider = messages;

    // Build provider options
    const providerOptions = {
      model: route.modelId,
      messages: messagesForProvider,
      system: data.system,
      max_tokens: data.max_tokens,
      temperature: data.temperature,
      top_p: data.top_p,
      top_k: data.top_k,
      stop_sequences: data.stop_sequences,
      tools: data.tools,
      tool_choice: data.tool_choice,
      metadata: data.metadata,
    };

    try {
      if (stream) {
        // —— Streaming ——
        let headerSent = false;
        let totalOutputTokens = 0;
        let ttfbMs: number | null = null;

        try {
          const gen = route.provider.streamMessages(route.apiKey, providerOptions);

          for await (const event of gen) {
            if (!headerSent) {
              ttfbMs = Date.now() - start;
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
              if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
              headerSent = true;
            }

            const line = `data: ${JSON.stringify(event)}\n\n`;
            res.write(line);

            if (event.type === 'content_block_delta') {
              const delta = event.delta as { type?: string; text?: string; partial_json?: string };
              if (delta.text) totalOutputTokens += Math.ceil(delta.text.length / 4);
              if (delta.partial_json) totalOutputTokens += Math.ceil(delta.partial_json.length / 4);
            }
          }

          recordRequest(route.platform, route.modelId, route.keyId);
          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messagesForProvider as any, route.modelDbId, sessionIdHeader);
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, ttfbMs, pinnedModelId);
          if (!res.writableEnded) res.end();
          return;
        } catch (streamErr: any) {
          if (headerSent) {
            console.error(`[anthropic] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = {
              type: 'error',
              error: { type: 'api_error', message: 'Provider error: stream interrupted' },
            };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { if (!res.writableEnded) res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message), ttfbMs, pinnedModelId);
            return;
          }
          throw streamErr;
        }
      } else {
        // —— Non-streaming ——
        const result = await route.provider.messages(route.apiKey, providerOptions);

        const totalTokens = (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
        recordRequest(route.platform, route.modelId, route.keyId);
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messagesForProvider as any, route.modelDbId, sessionIdHeader);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(result);

        logRequest(route.platform, route.modelId, route.keyId, 'success', result.usage?.input_tokens ?? 0, result.usage?.output_tokens ?? 0, Date.now() - start, null, null, pinnedModelId);
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, null, pinnedModelId);

      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);

        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        setCooldown(
          route.platform, route.modelId, route.keyId,
          isPaymentRequiredError(err)
            ? PAYMENT_REQUIRED_COOLDOWN_MS
            : isModelAccessForbiddenError(err)
            ? MODEL_FORBIDDEN_COOLDOWN_MS
            : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, {
                rpd: route.rpdLimit,
                tpd: route.tpdLimit,
              }, (err as any).retryAfterMs),
        );
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[anthropic] ${safeError.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      res.status(502).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Provider error (${route.displayName}): ${safeError}`,
        },
      });
      return;
    }
  }

  // Exhausted all retries
  res.status(429).json({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${sanitizeProviderErrorMessage(lastError?.message)}`,
    },
  });
});

// ---- Request logging ----

function logRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  ttfbMs: number | null = null,
  requestedModel: string | null = null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error, ttfbMs, requestedModel);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
