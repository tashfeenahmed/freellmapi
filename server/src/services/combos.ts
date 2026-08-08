/**
 * Combos — named, ordered model groups with a custom routing strategy.
 *
 * A combo is a user-defined list of models that can be requested by name
 * in the `model` field instead of a single model id. The router (Phase 2)
 * will resolve a combo request by trying its models in order (fallback),
 * rotating through them (round-robin), or calling them in parallel (fusion).
 *
 * Pure by design: the core functions take a Db handle and touch no globals,
 * so they're trivially testable. Only the getter/setter conveniences are
 * injected in the route layer.
 */
import { z } from 'zod';
import type { Db } from '../db/types.js';

// ── Validation ──────────────────────────────────────────────────────────────

export const COMBO_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export const comboStrategySchema = z.enum(['fallback', 'round-robin', 'fusion']);
export type ComboStrategy = z.infer<typeof comboStrategySchema>;

export const comboKindSchema = z.enum(['chat', 'fusion']);
export type ComboKind = z.infer<typeof comboKindSchema>;

export const comboUpdateSchema = z.object({
  name: z.string().min(1).max(80).regex(COMBO_NAME_RE, 'Name can only contain letters, numbers, -, _, and .').optional(),
  description: z.string().max(500).optional(),
  models: z.array(z.string().min(1)).min(1).max(50).optional(),
  strategy: comboStrategySchema.optional(),
  sticky_limit: z.number().int().min(1).max(100).optional(),
  judge_model: z.string().min(1).max(200).nullable().optional(),
  kind: comboKindSchema.optional(),
}).strict();

export const comboCreateSchema = z.object({
  name: z.string().min(1).max(80).regex(COMBO_NAME_RE, 'Name can only contain letters, numbers, -, _, and .'),
  description: z.string().max(500).default(''),
  models: z.array(z.string().min(1)).min(1).max(50),
  strategy: comboStrategySchema.default('fallback'),
  sticky_limit: z.number().int().min(1).max(100).default(1),
  judge_model: z.string().min(1).max(200).nullable().default(null),
  kind: comboKindSchema.default('chat'),
}).strict();

export type ComboCreateInput = z.infer<typeof comboCreateSchema>;
export type ComboUpdateInput = z.infer<typeof comboUpdateSchema>;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ComboRow {
  id: number;
  name: string;
  description: string;
  models: string;        // JSON array string from DB
  strategy: string;
  sticky_limit: number;
  judge_model: string | null;
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface Combo {
  id: number;
  name: string;
  description: string;
  models: string[];
  strategy: ComboStrategy;
  stickyLimit: number;
  judgeModel: string | null;
  kind: ComboKind;
  createdAt: string;
  updatedAt: string;
}

// ── Row ↔ Object mapping ─────────────────────────────────────────────────────

function rowToCombo(row: ComboRow): Combo {
  let parsed: string[];
  try {
    parsed = JSON.parse(row.models) as string[];
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    parsed = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    models: parsed,
    strategy: (['fallback', 'round-robin', 'fusion'].includes(row.strategy)
      ? row.strategy : 'fallback') as ComboStrategy,
    stickyLimit: row.sticky_limit,
    judgeModel: row.judge_model,
    kind: (['chat', 'fusion'].includes(row.kind) ? row.kind : 'chat') as ComboKind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/** Get all combos, ordered by creation time. */
export function getAllCombos(db: Db): Combo[] {
  const rows = db.prepare(
    'SELECT * FROM combos ORDER BY created_at ASC'
  ).all() as ComboRow[];
  return rows.map(rowToCombo);
}

/** Get a single combo by id. Returns null if not found. */
export function getComboById(db: Db, id: number): Combo | null {
  const row = db.prepare('SELECT * FROM combos WHERE id = ?').get(id) as ComboRow | undefined;
  return row ? rowToCombo(row) : null;
}

/** Get a single combo by name (case-sensitive). Returns null if not found. */
export function getComboByName(db: Db, name: string): Combo | null {
  const row = db.prepare('SELECT * FROM combos WHERE name = ?').get(name) as ComboRow | undefined;
  return row ? rowToCombo(row) : null;
}

/** Create a new combo. Returns the created combo with its generated id. */
export function createCombo(db: Db, input: ComboCreateInput): Combo {
  const now = new Date().toISOString();
  const modelsJson = JSON.stringify(input.models);

  const result = db.prepare(`
    INSERT INTO combos (name, description, models, strategy, sticky_limit, judge_model, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.description,
    modelsJson,
    input.strategy,
    input.sticky_limit,
    input.judge_model,
    input.kind,
    now,
    now,
  );

  const inserted = getComboById(db, Number(result.lastInsertRowid));
  if (!inserted) throw new Error('Failed to retrieve newly created combo');
  return inserted;
}

/** Update an existing combo. Only provided fields are changed. Returns the updated combo, or null if not found. */
export function updateCombo(db: Db, id: number, input: ComboUpdateInput): Combo | null {
  const existing = getComboById(db, id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const setters: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) { setters.push('name = ?'); values.push(input.name); }
  if (input.description !== undefined) { setters.push('description = ?'); values.push(input.description); }
  if (input.models !== undefined) { setters.push('models = ?'); values.push(JSON.stringify(input.models)); }
  if (input.strategy !== undefined) { setters.push('strategy = ?'); values.push(input.strategy); }
  if (input.sticky_limit !== undefined) { setters.push('sticky_limit = ?'); values.push(input.sticky_limit); }
  if (input.judge_model !== undefined) { setters.push('judge_model = ?'); values.push(input.judge_model); }
  if (input.kind !== undefined) { setters.push('kind = ?'); values.push(input.kind); }
  setters.push('updated_at = ?');
  values.push(now);

  values.push(id);
  db.prepare(`UPDATE combos SET ${setters.join(', ')} WHERE id = ?`).run(...values);

  return getComboById(db, id);
}

/** Delete a combo by id. Returns true if a row was deleted. */
export function deleteCombo(db: Db, id: number): boolean {
  const result = db.prepare('DELETE FROM combos WHERE id = ?').run(id);
  return (result.changes ?? 0) > 0;
}

/**
 * Check whether a given model string refers to a combo name.
 * Returns the resolved Combo or null.
 */
export function resolveCombo(db: Db, modelStr: string): Combo | null {
  // A model string that contains a '/' is likely "platform:model_id" — not a combo.
  if (modelStr.includes('/')) return null;
  return getComboByName(db, modelStr);
}

/**
 * Return all combo names (for populating virtual model listings).
 */
export function getComboModelIds(db: Db): string[] {
  const rows = db.prepare('SELECT name FROM combos').all() as { name: string }[];
  return rows.map(r => r.name);
}
