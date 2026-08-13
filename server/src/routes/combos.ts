import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb, getSetting } from '../db/index.js';
import { validateSession } from '../services/auth.js';
import { timingSafeEqual } from 'crypto';
import {
  getAllCombos,
  getComboById,
  getComboByName,
  createCombo,
  updateCombo,
  deleteCombo,
  comboCreateSchema,
  comboUpdateSchema,
} from '../services/combos.js';

export const combosRouter = Router();

// Accept both dashboard session tokens AND the unified API key.
// Dashboard users authenticate via /api/auth/login and send the session
// token as `Authorization: Bearer <token>`. CLI/script users can send the
// unified API key (freellmapi-...) the same way.
function comboAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);

  // Try dashboard session first
  if (token) {
    const session = validateSession(token);
    if (session) {
      (req as Request & { user?: unknown }).user = session;
      next();
      return;
    }
  }

  // Fall back to unified API key
  if (token) {
    const stored = getSetting('unified_api_key');
    if (stored) {
      // Constant-time comparison
      const bufA = Buffer.from(token);
      const bufB = Buffer.from(stored);
      if (bufA.length === bufB.length && timingSafeEqual(bufA, bufB)) {
        next();
        return;
      }
    }
  }

  res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
}

// Apply auth to all routes
combosRouter.use(comboAuth);

const NOT_FOUND = { error: { message: 'Combo not found' } };

// GET /api/combos — list all combos
combosRouter.get('/', (_req: Request, res: Response) => {
  const combos = getAllCombos(getDb());
  res.json({ combos });
});

// GET /api/combos/:id — get a single combo by id
combosRouter.get('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid combo id' } });
    return;
  }
  const combo = getComboById(getDb(), id);
  if (!combo) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  res.json(combo);
});

// POST /api/combos — create a new combo
combosRouter.post('/', (req: Request, res: Response) => {
  const parsed = comboCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid combo: ${detail}` } });
    return;
  }

  const db = getDb();

  // Check name uniqueness
  const existing = getComboByName(db, parsed.data.name);
  if (existing) {
    res.status(409).json({ error: { message: `Combo "${parsed.data.name}" already exists` } });
    return;
  }

  const combo = createCombo(db, parsed.data);
  res.status(201).json(combo);
});

// PATCH /api/combos/:id — update an existing combo
combosRouter.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid combo id' } });
    return;
  }

  const parsed = comboUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid combo update: ${detail}` } });
    return;
  }

  const db = getDb();

  // If renaming, check the new name doesn't collide
  if (parsed.data.name) {
    const byName = getComboByName(db, parsed.data.name);
    if (byName && byName.id !== id) {
      res.status(409).json({ error: { message: `Combo "${parsed.data.name}" already exists` } });
      return;
    }
  }

  const combo = updateCombo(db, id, parsed.data);
  if (!combo) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  res.json(combo);
});

// DELETE /api/combos/:id — delete a combo
combosRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid combo id' } });
    return;
  }

  const db = getDb();
  const existing = getComboById(db, id);
  if (!existing) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  deleteCombo(db, id);
  res.json({ success: true, id });
});
