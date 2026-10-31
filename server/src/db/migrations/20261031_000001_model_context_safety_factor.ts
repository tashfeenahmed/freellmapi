// Migration: per-model context safety factor
// Created: 2026-10-31
//
// DOWN: reversible (DROP COLUMN)
//
// The router divides a model's raw context window by a safety factor before
// deciding whether a request fits. The global default lives in
// CONTEXT_WINDOW_SAFETY_FACTOR (1.25); this column lets a single model override
// it. NULL means "use the global default".
//
// Guarded like every other column add: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'models', 'context_safety_factor')) {
    db.prepare('ALTER TABLE models ADD COLUMN context_safety_factor REAL').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'models', 'context_safety_factor')) {
    db.prepare('ALTER TABLE models DROP COLUMN context_safety_factor').run();
  }
}
