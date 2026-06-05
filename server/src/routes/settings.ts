import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey, regenerateUnifiedKey } from '../db/index.js';
import { maskKey } from '../lib/crypto.js';

export const settingsRouter = Router();

// Return only metadata by default. The full unified key is sensitive because it
// authenticates /v1 proxy traffic; do not hydrate it into the dashboard unless
// the user explicitly clicks reveal/copy.
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  const apiKey = getUnifiedApiKey();
  res.json({ maskedKey: maskKey(apiKey), prefix: apiKey.slice(0, 'freellmapi-'.length) });
});

// Explicit reveal endpoint for the dashboard. Still behind requireAuth in
// app.ts, but separated from the default metadata path to avoid accidental leaks
// through eager query caches, devtools snapshots, or page-load logging.
settingsRouter.post('/api-key/reveal', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key. This intentionally returns the new key once so
// the user can copy it immediately; subsequent GET requests remain masked.
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey, maskedKey: maskKey(newKey) });
});
