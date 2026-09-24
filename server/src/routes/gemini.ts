import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUnifiedApiKey } from '../db/index.js';
import { buildModelListing, type NormalizedModel } from '../services/model-listing.js';
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import { runInboundChat, type InboundChatWire } from '../lib/inbound-chat.js';
import {
  effortFromGeminiThinking,
  estimateGeminiTokens,
  geminiContentsToMessages,
  geminiFinishReason,
  geminiPartsFromResult,
  geminiResponseFormat,
  geminiResponseFromResult,
  geminiToolChoice,
  geminiToolsToChatTools,
  type GeminiInboundRequest,
} from '../lib/gemini-wire.js';
import { resolveGeminiModel } from '../services/gemini-map.js';

export const geminiRouter = Router();

const partSchema = z.object({}).passthrough();
const contentSchema = z.object({
  role: z.enum(['user', 'model']).optional(),
  parts: z.array(partSchema).optional(),
}).passthrough();
const generateSchema = z.object({
  contents: z.array(contentSchema).min(1),
  systemInstruction: z.object({ parts: z.array(partSchema).optional() }).passthrough().optional(),
  tools: z.array(z.object({}).passthrough()).optional(),
  toolConfig: z.object({}).passthrough().optional(),
  generationConfig: z.object({}).passthrough().optional(),
}).passthrough();

function sendError(res: Response, status: number, message: string, code = 'INVALID_ARGUMENT'): void {
  res.status(status).json({
    error: {
      code: status,
      message,
      status: code.toUpperCase(),
    },
  });
}

function authenticate(req: Request, res: Response): boolean {
  const queryKey = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  if (queryKey) {
    // Query credentials are a Gemini compatibility escape hatch and are
    // intentionally scoped to this router. Warn because URLs commonly land in
    // shell history, reverse-proxy logs, and referrer telemetry.
    console.warn('[Gemini] API key supplied in ?key=; prefer x-goog-api-key to avoid URL leakage');
  }
  const token = extractApiToken(req) ?? queryKey;
  if (!token || !timingSafeStringEqual(token, getUnifiedApiKey())) {
    sendError(res, 401, 'Invalid API key', 'UNAUTHENTICATED');
    return false;
  }
  return true;
}

function modelShape(model: NormalizedModel | null, autoContextWindow: number | null, id = 'auto') {
  const context = model?.contextWindow ?? autoContextWindow ?? 128_000;
  return {
    name: `models/${model?.id ?? id}`,
    displayName: model?.name ?? 'Auto (router picks the best available model)',
    description: model
      ? `FreeLLMAPI catalog model served by ${model.ownedBy}`
      : 'FreeLLMAPI automatically selects the best available model',
    inputTokenLimit: context,
    // The current catalog does not yet carry a separate output ceiling. Keep a
    // conservative interoperable value instead of inventing per-model limits.
    outputTokenLimit: Math.min(8192, context),
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
    version: model?.id ?? id,
  };
}

geminiRouter.get('/models', (req, res) => {
  if (!authenticate(req, res)) return;
  const { models, autoContextWindow } = buildModelListing();
  const availableOnly = String(req.query.available ?? '').toLowerCase();
  const listed = ['1', 'true', 'yes'].includes(availableOnly)
    ? models.filter(model => model.available === 1)
    : models;
  res.json({
    models: [
      modelShape(null, autoContextWindow),
      ...listed.map(model => modelShape(model, autoContextWindow)),
    ],
  });
});

geminiRouter.get(/^\/models\/(.+)$/, (req, res) => {
  if (!authenticate(req, res)) return;
  const requested = decodeURIComponent(req.params[0]).replace(/^models\//, '');
  const { models, autoContextWindow } = buildModelListing();
  if (requested === 'auto') {
    res.json(modelShape(null, autoContextWindow));
    return;
  }
  const model = models.find(entry => entry.id === requested);
  if (!model) {
    sendError(res, 404, `Model '${requested}' was not found`, 'NOT_FOUND');
    return;
  }
  res.json(modelShape(model, autoContextWindow));
});

function parseGenerateBody(req: Request, res: Response): GeminiInboundRequest | null {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .slice(0, 5)
      .map(error => `${error.path.join('.') || 'body'}: ${error.message}`)
      .join(', ');
    sendError(res, 400, `Invalid Gemini request: ${detail}`);
    return null;
  }
  return parsed.data as GeminiInboundRequest;
}

function actionModel(req: Request, suffix: string): string {
  const encoded = req.path.slice('/models/'.length, -suffix.length);
  return decodeURIComponent(encoded).replace(/^models\//, '');
}

function streamWire(altSse: boolean): InboundChatWire {
  let firstJsonChunk = true;
  const write = (res: Response, payload: Record<string, unknown>) => {
    const serialized = JSON.stringify(payload);
    if (altSse) {
      res.write(`data: ${serialized}\n\n`);
    } else {
      res.write(`${firstJsonChunk ? '' : ','}\n${serialized}`);
      firstJsonChunk = false;
    }
  };
  return {
    sendError,
    sendNonStream: (res, result) => res.json(geminiResponseFromResult(result)),
    startStream: (res) => {
      res.setHeader('Content-Type', altSse ? 'text/event-stream' : 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      if (!altSse) res.write('[');
    },
    sendTextDelta: (res, _route, text) => write(res, {
      candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
    }),
    sendReasoningDelta: (res, _route, text) => write(res, {
      candidates: [{ content: { role: 'model', parts: [{ text, thought: true }] }, index: 0 }],
    }),
    sendToolCalls: (res, _route, calls) => write(res, {
      candidates: [{
        content: {
          role: 'model',
          parts: geminiPartsFromResult({ text: '', reasoning: '', toolCalls: calls }),
        },
        index: 0,
      }],
    }),
    finishStream: (res, result) => {
      write(res, {
        candidates: [{
          content: { role: 'model', parts: [] },
          finishReason: geminiFinishReason(result.finishReason, result.toolCalls.length > 0),
          index: 0,
        }],
        usageMetadata: {
          promptTokenCount: result.promptTokens,
          candidatesTokenCount: result.completionTokens,
          totalTokenCount: result.promptTokens + result.completionTokens,
        },
        modelVersion: result.route.modelId,
      });
      if (!altSse) res.write('\n]');
      res.end();
    },
    sendStreamError: (res, message) => {
      write(res, { error: { code: 502, message, status: 'UNAVAILABLE' } });
      if (!altSse) res.write('\n]');
    },
  };
}

async function handleGenerate(req: Request, res: Response, stream: boolean): Promise<void> {
  if (!authenticate(req, res)) return;
  const body = parseGenerateBody(req, res);
  if (!body) return;
  const generation = body.generationConfig;
  const model = actionModel(
    req,
    stream ? ':streamGenerateContent' : ':generateContent',
  );
  const rawSession = req.headers['x-goog-request-id'] ?? req.headers['x-session-id'];
  const sessionId = Array.isArray(rawSession) ? rawSession[0] : rawSession;
  const tools = geminiToolsToChatTools(body.tools);
  await runInboundChat(req, res, {
    model: resolveGeminiModel(model),
    messages: geminiContentsToMessages(body),
    stream,
    // Gemini CLI never sends maxOutputTokens; the shared 1024-token default
    // would truncate every response, so match Gemini's own model default.
    maxTokens: generation?.maxOutputTokens ?? 8192,
    temperature: generation?.temperature,
    topP: generation?.topP,
    topK: generation?.topK,
    stop: generation?.stopSequences,
    tools,
    // tool_choice without tools 400s on strict OpenAI-compatible upstreams.
    toolChoice: tools ? geminiToolChoice(body.toolConfig) : undefined,
    responseFormat: geminiResponseFormat(generation),
    reasoningEffort: effortFromGeminiThinking(generation),
    sessionId,
    endpoint: stream ? 'gemini/streamGenerateContent' : 'gemini/generateContent',
  }, streamWire(String(req.query.alt ?? '').toLowerCase() === 'sse'));
}

// The handler promise is RETURNED, not voided, so Express 5 forwards a
// rejection to errorHandler like it already does for the OpenAI (/v1) and
// Anthropic (/v1/messages) surfaces, whose handlers are `async` and so hand
// Express their promise. A voided promise escapes the router entirely and
// resurfaces as an `unhandledRejection`, which the process safety net
// classifies as fatal for anything that is not a transport error — so one
// failing request exited the whole gateway instead of answering 500.
geminiRouter.post(/^\/models\/(.+):generateContent$/, (req, res) => handleGenerate(req, res, false));

geminiRouter.post(/^\/models\/(.+):streamGenerateContent$/, (req, res) => handleGenerate(req, res, true));

geminiRouter.post(/^\/models\/(.+):countTokens$/, (req, res) => {
  if (!authenticate(req, res)) return;
  const body = parseGenerateBody(req, res);
  if (!body) return;
  res.json({ totalTokens: estimateGeminiTokens(body) });
});
