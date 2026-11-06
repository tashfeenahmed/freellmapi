import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { listSearchEngines, updateSearchEngine, runSearch, SearchError } from '../services/search.js';

// Dashboard: the Models → Search page (#1174). Engines come from the catalog's
// searchEngines registry (plus custom relays); this lists them with key and
// usage counts and lets the operator switch one off or change the order.
export const searchRouter = Router();

searchRouter.get('/engines', (_req: Request, res: Response) => {
  res.json(listSearchEngines());
});

searchRouter.post('/engines/:id/test', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = z.object({ query: z.string().trim().min(1).max(400) }).safeParse(req.body);
  if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
    res.status(400).json({ error: { message: 'A valid engine and query are required' } });
    return;
  }
  try {
    res.json(await runSearch(parsed.data.query, { engineRowId: id, maxResults: 1, clientAgent: 'dashboard' }));
  } catch (err: unknown) {
    const status = err instanceof SearchError ? err.status : 502;
    res.status(status).json({ error: { message: err instanceof Error ? err.message : 'Search test failed' } });
  }
});

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
}).refine(p => p.enabled !== undefined || p.priority !== undefined, {
  message: 'Provide enabled and/or priority',
});

searchRouter.patch('/engines/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid engine id' } });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  if (!updateSearchEngine(id, parsed.data)) {
    res.status(404).json({ error: { message: 'Search engine not found' } });
    return;
  }
  const engine = listSearchEngines().find(e => e.id === id);
  res.json(engine);
});
