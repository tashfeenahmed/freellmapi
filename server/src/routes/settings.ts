import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey, regenerateUnifiedKey, getDefaultSystemPrompt, setDefaultSystemPrompt } from '../db/index.js';

export const settingsRouter = Router();

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// Default system prompt — injected at proxy level so every model gets the same base persona
settingsRouter.get('/system-prompt', (_req: Request, res: Response) => {
  res.json({ prompt: getDefaultSystemPrompt() ?? '' });
});

settingsRouter.put('/system-prompt', async (req: Request, res: Response) => {
  const { prompt } = req.body as { prompt?: string };
  if (prompt === undefined) {
    res.status(400).json({ error: { message: 'prompt is required', type: 'invalid_request_error' } });
    return;
  }
  setDefaultSystemPrompt(prompt);
  res.json({ prompt: getDefaultSystemPrompt() ?? '' });
});
