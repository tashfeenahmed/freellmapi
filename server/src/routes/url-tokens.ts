import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { getUnifiedApiKey } from '../db/index.js';
import { ollamaRouter } from './ollama.js';
import { proxyRouter } from './proxy.js';
import { responsesRouter } from './responses.js';
import { validateUrlToken } from '../services/url-tokens.js';

export const urlTokenRouter = Router({ mergeParams: true });

urlTokenRouter.use((req: Request, res: Response, next: NextFunction) => {
  const token = String(req.params.token ?? '');
  if (!validateUrlToken(token)) {
    res.status(401).json({
      error: {
        message: 'Invalid or revoked URL token',
        type: 'authentication_error',
      },
    });
    return;
  }
  // A URL token buys headerless INFERENCE, not the operator's console. The
  // injection below makes the request look unified to every downstream
  // router, so routes that read only for the unified key check THIS flag and
  // refuse — otherwise a shareable, revocable token handed to a headerless
  // client reads exactly what the client-profile-key rule in routes/proxy.ts
  // forbids: the install-wide spend ledger (/v1/usage reports every key's
  // monthly spend, caps and which account is nearly drained).
  // Downstream protocol routers retain their normal authentication checks.
  // Supply the unified key internally only after the separately revocable URL
  // token was verified; it never appears in the public URL.
  req.headers.authorization = `Bearer ${getUnifiedApiKey()}`;
  (req as Request & { urlTokenAuthenticated?: boolean }).urlTokenAuthenticated = true;
  next();
});

// OpenAI models/chat and Responses under /v1/t/{token}/...
urlTokenRouter.use(proxyRouter);
urlTokenRouter.use(responsesRouter);

// Headerless clients may also use /v1/t/{token}/api/chat and /api/tags.
urlTokenRouter.use(ollamaRouter);
