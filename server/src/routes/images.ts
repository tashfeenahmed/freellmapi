import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import { getUnifiedApiKey } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import type { ImageGenerationRequest } from '@freellmapi/shared/types.js';

export const imagesRouter = Router();

const imageGenSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: z.string().optional(),
  n: z.number().int().min(1).max(4).optional(),
  size: z.string().regex(/^\d+x\d+$/).optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
  user: z.string().optional(),
}).passthrough();

/**
 * POST /v1/images/generations — OpenAI-compatible image generation.
 *
 * Routing today is direct: model="flux" (or any Pollinations model) hits the
 * Pollinations image provider. When more image providers land, this handler
 * should grow the same router/failover logic as /v1/chat/completions
 * (see proxy.ts). Kept simple for the PR-1 surface.
 */
imagesRouter.post('/images/generations', async (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const parsed = imageGenSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5).join(', ');
    console.warn(`[images] 400 invalid request: ${detail}`);
    res.status(400).json({
      error: { message: `Invalid request: ${detail}`, type: 'invalid_request_error' },
    });
    return;
  }

  const provider = resolveProvider('pollinations-image');
  if (!provider || !provider.supportsImages()) {
    res.status(503).json({
      error: { message: 'No image generation provider configured', type: 'server_error' },
    });
    return;
  }

  try {
    const result = await provider.generateImage('', parsed.data as ImageGenerationRequest);
    res.json(result);
  } catch (err: any) {
    const status = err?.status ?? 502;
    const type = status === 400 ? 'invalid_request_error'
      : status === 402 ? 'rate_limit_error'  // Pollinations concurrent limit; map to OpenAI's nearest type so clients can retry
      : status === 429 ? 'rate_limit_error'
      : 'server_error';
    console.warn(`[images] ${status} ${err?.message ?? 'unknown'}`);
    res.status(status).json({
      error: { message: `image generation error: ${err?.message ?? 'unknown'}`, type },
    });
  }
});
