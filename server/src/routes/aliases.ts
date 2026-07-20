import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import type { AliasLevel } from '@freellmapi/shared/types.js';

export const aliasesRouter = Router();

const LEVEL_VALUES: AliasLevel[] = ['high', 'middle', 'low'];
const RESERVED_NAMES = ['high-level', 'middle-level', 'low-level'];

function isReservedName(name: string): boolean {
  return RESERVED_NAMES.includes(name.toLowerCase());
}

function normalizeLevel(level: unknown): AliasLevel | null {
  if (typeof level !== 'string') return null;
  const l = level.toLowerCase();
  return LEVEL_VALUES.includes(l as AliasLevel) ? (l as AliasLevel) : null;
}

// List all aliases with their member model ids. Ordered by level (high first,
// then middle, then low) then priority. Used by the dashboard's logical-model
// management section.
aliasesRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const aliases = db.prepare(`
    SELECT id, name, level, priority, enabled, created_at
    FROM aliases
    ORDER BY CASE level WHEN 'high' THEN 0 WHEN 'middle' THEN 1 ELSE 2 END, priority ASC
  `).all() as any[];
  const memberRows = db.prepare(
    'SELECT alias_id, id FROM models WHERE alias_id IS NOT NULL ORDER BY alias_priority ASC',
  ).all() as { alias_id: number; id: number }[];
  const membersByAlias = new Map<number, number[]>();
  for (const r of memberRows) {
    if (!membersByAlias.has(r.alias_id)) membersByAlias.set(r.alias_id, []);
    membersByAlias.get(r.alias_id)!.push(r.id);
  }
  res.json(aliases.map(a => ({
    id: a.id,
    name: a.name,
    level: a.level,
    priority: a.priority,
    enabled: a.enabled === 1,
    createdAt: a.created_at,
    memberModelIds: membersByAlias.get(a.id) ?? [],
  })));
});

// Create an alias. level defaults to 'low'. Rejects reserved names
// (high-level/middle-level/low-level, case-insensitive) so they cannot collide
// with the level routing entry points, and rejects duplicate names.
aliasesRouter.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 100) return res.status(400).json({ error: 'name must be ≤ 100 characters' });
  if (isReservedName(name)) {
    return res.status(400).json({ error: `Name '${name}' is reserved for level routing (high-level/middle-level/low-level)` });
  }
  const level = body.level === undefined ? 'low' : normalizeLevel(body.level);
  if (level === null) return res.status(400).json({ error: 'level must be one of high|middle|low' });
  const priority = typeof body.priority === 'number' && Number.isFinite(body.priority)
    ? Math.trunc(body.priority) : 0;
  const enabled = body.enabled === false ? 0 : 1;

  const db = getDb();
  const existing = db.prepare('SELECT id FROM aliases WHERE name = ?').get(name) as { id: number } | undefined;
  if (existing) return res.status(409).json({ error: 'Alias already exists', existingId: existing.id });

  const info = db.prepare(
    'INSERT INTO aliases (name, level, priority, enabled) VALUES (?, ?, ?, ?)',
  ).run(name, level, priority, enabled);
  const id = Number(info.lastInsertRowid);
  res.status(201).json({ id, name, level, priority, enabled: enabled === 1 });
});

// Update name/level/priority/enabled. Rename triggers reserved-name and
// duplicate checks (the duplicate check excludes the row being renamed).
aliasesRouter.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const db = getDb();
  const row = db.prepare('SELECT id FROM aliases WHERE id = ?').get(id) as { id: number } | undefined;
  if (!row) return res.status(404).json({ error: 'alias not found' });

  const sets: string[] = [];
  const params: any[] = [];
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    if (isReservedName(name)) {
      return res.status(400).json({ error: `Name '${name}' is reserved for level routing` });
    }
    const dup = db.prepare('SELECT id FROM aliases WHERE name = ? AND id != ?').get(name, id) as { id: number } | undefined;
    if (dup) return res.status(409).json({ error: 'Alias already exists', existingId: dup.id });
    sets.push('name = ?');
    params.push(name);
  }
  if (body.level !== undefined) {
    const level = normalizeLevel(body.level);
    if (level === null) return res.status(400).json({ error: 'level must be one of high|middle|low' });
    sets.push('level = ?');
    params.push(level);
  }
  if (typeof body.priority === 'number' && Number.isFinite(body.priority)) {
    sets.push('priority = ?');
    params.push(Math.trunc(body.priority));
  }
  if (typeof body.enabled === 'boolean') {
    sets.push('enabled = ?');
    params.push(body.enabled ? 1 : 0);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'no editable fields provided' });

  params.push(id);
  db.prepare(`UPDATE aliases SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare(
    'SELECT id, name, level, priority, enabled, created_at FROM aliases WHERE id = ?',
  ).get(id) as any;
  res.json({
    id: updated.id,
    name: updated.name,
    level: updated.level,
    priority: updated.priority,
    enabled: updated.enabled === 1,
    createdAt: updated.created_at,
  });
});

// Delete an alias. The FK ON DELETE SET NULL clears alias_id on member models,
// so they stay in the catalog (still reachable via auto or exact model_id pin)
// but drop out of level/alias routing.
aliasesRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const db = getDb();
  const row = db.prepare('SELECT id FROM aliases WHERE id = ?').get(id) as { id: number } | undefined;
  if (!row) return res.status(404).json({ error: 'alias not found' });
  db.prepare('DELETE FROM aliases WHERE id = ?').run(id);
  res.json({ success: true });
});
