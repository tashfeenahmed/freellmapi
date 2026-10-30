// POST /api/glixel/chat — the GLIXEL assistant's chat endpoint, behind the
// dashboard session gate (mounted with requireAuth in app.ts).
//
// It runs the same pipeline as every other chat surface (lib/inbound-chat.ts):
// automatic routing with free-only enforcement, fallback, request logging and
// client-abort handling. GLIXEL only adds the server-enforced persona and a
// small SSE wire that carries the router's real routing facts (X-Routed-Via,
// X-Fallback-Trail) to the app, so the app never needs an API key.
//
// Events (text/event-stream, one JSON object per `data:` line):
//   {"type":"route","platform","model","displayName","fallbackAttempts","fallbackTrail"}
//   {"type":"delta","text"}
//   {"type":"done","finishReason","promptTokens","completionTokens","latencyMs"}
//   {"type":"error","message","code"}
// Errors before the stream starts are plain JSON with an HTTP status.
//
// GET /api/glixel/capabilities — which AI paths exist and whether they work,
// plus the routing policy, which is set by environment variables and so is
// read-only here. Contains no key material.
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { runInboundChat, type InboundChatWire } from '../lib/inbound-chat.js';
import { GLIXEL_PERSONA } from '../glixel/persona.js';
import { GLIXEL_DEFAULT_PROVIDER, GLIXEL_PROVIDER_IDS, glixelProviders } from '../glixel/providers.js';
import { freeOnlyPolicySummary, isFreeOnlyEnabled } from '../services/free-only.js';
import { getFallbackMaxAttempts } from '../lib/fallback-loop.js';

export const glixelRouter = Router();

export const GLIXEL_MAX_MESSAGES = 100;
export const GLIXEL_MAX_MESSAGE_CHARS = 32_000;
export const GLIXEL_MAX_TOTAL_CHARS = 200_000;
const GLIXEL_MAX_OUTPUT_TOKENS = 2048;

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(GLIXEL_MAX_MESSAGE_CHARS),
  }).strict()).min(1).max(GLIXEL_MAX_MESSAGES),
  conversationId: z.number().int().positive().optional(),
  // The user's explicit choice of AI path. An unavailable path is refused,
  // never swapped for another one.
  provider: z.enum(GLIXEL_PROVIDER_IDS).default(GLIXEL_DEFAULT_PROVIDER),
}).strict();

function header(res: Response, name: string): string | undefined {
  const value = res.getHeader(name);
  return value === undefined ? undefined : String(value);
}

function sse(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function glixelWire(startedAt: number): InboundChatWire {
  const routeEvent = (res: Response, route: { platform: string; modelId: string; displayName: string }) => ({
    type: 'route',
    platform: route.platform,
    model: route.modelId,
    displayName: route.displayName,
    fallbackAttempts: Number(header(res, 'X-Fallback-Attempts') ?? 0),
    fallbackTrail: header(res, 'X-Fallback-Trail') ?? null,
  });
  return {
    sendError: (res, status, message, code) => {
      if (res.headersSent) {
        if (!res.writableEnded) { sse(res, { type: 'error', message, code: code ?? null }); res.end(); }
        return;
      }
      res.status(status).json({ error: { message, code: code ?? null } });
    },
    sendNonStream: (res, result) => {
      res.json({
        route: routeEvent(res, result.route),
        text: result.text,
        finishReason: result.finishReason,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: Date.now() - startedAt,
      });
    },
    startStream: (res, route) => {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      sse(res, routeEvent(res, route));
    },
    sendTextDelta: (res, _route, text) => sse(res, { type: 'delta', text }),
    finishStream: (res, result) => {
      sse(res, {
        type: 'done',
        finishReason: result.finishReason,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: Date.now() - startedAt,
      });
      res.end();
    },
    sendStreamError: (res, message) => sse(res, { type: 'error', message, code: 'upstream_error' }),
  };
}

glixelRouter.get('/capabilities', (_req: Request, res: Response) => {
  res.json({
    providers: glixelProviders(isFreeOnlyEnabled()),
    defaultProvider: GLIXEL_DEFAULT_PROVIDER,
    routing: {
      source: 'environment',
      freeOnly: freeOnlyPolicySummary(),
      fallbackMaxAttempts: getFallbackMaxAttempts(),
    },
  });
});

glixelRouter.post('/chat', async (req: Request, res: Response) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '), code: 'invalid_request' } });
    return;
  }
  const { messages, conversationId, provider } = parsed.data;
  const path = glixelProviders(isFreeOnlyEnabled()).find(p => p.id === provider)!;
  if (!path.available) {
    res.status(503).json({ error: { message: path.reason, code: 'provider_unavailable', provider } });
    return;
  }
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > GLIXEL_MAX_TOTAL_CHARS) {
    res.status(413).json({ error: { message: `Conversation is too long (${total} characters; the limit is ${GLIXEL_MAX_TOTAL_CHARS}). Start a new conversation.`, code: 'conversation_too_long' } });
    return;
  }
  if (messages[messages.length - 1].role !== 'user' || !messages[messages.length - 1].content.trim()) {
    res.status(400).json({ error: { message: 'The last message must be a non-empty user message.', code: 'invalid_request' } });
    return;
  }

  await runInboundChat(req, res, {
    model: 'auto',
    messages: [{ role: 'system', content: GLIXEL_PERSONA }, ...messages],
    stream: true,
    maxTokens: GLIXEL_MAX_OUTPUT_TOKENS,
    sessionId: conversationId ? `glixel:${conversationId}` : undefined,
    endpoint: '/api/glixel/chat',
  }, glixelWire(Date.now()));
});
