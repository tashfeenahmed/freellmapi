import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { extractApiToken } from './proxy.js';
import { resolveAuth } from '../lib/system-prompt.js';
import { runModerations, ModerationError } from '../services/moderation.js';

export const moderationRouter = Router();

function requireInferenceAuth(req: Request, res: Response): boolean {
  const token = extractApiToken(req);
  const auth = resolveAuth(token);
  if (!auth) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return false;
  }
  return true;
}

const moderationBody = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
});

moderationRouter.post('/moderations', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;

  const parsed = moderationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors.map(e => e.message).join(', '),
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { model, input } = parsed.data;
  const inputs = Array.isArray(input) ? input : [input];

  if (inputs.length === 0) {
    res.status(400).json({
      error: { message: 'input must not be empty', type: 'invalid_request_error' },
    });
    return;
  }

  try {
    const { provider, model: usedModel, result } = await runModerations(model, inputs);
    const upstream = result as { id?: string; model?: string; results?: unknown[] };

    res.json({
      id: upstream.id ?? `modr-${Date.now()}`,
      model: usedModel,
      results: upstream.results ?? [],
      _provider: provider,
    });
  } catch (err: any) {
    const status = err instanceof ModerationError ? err.status : 502;
    res.status(status >= 400 && status < 600 ? status : 502).json({
      error: {
        message: err?.message ?? 'moderation request failed',
        type: status === 429 ? 'rate_limit_error' : 'server_error',
      },
    });
  }
});
