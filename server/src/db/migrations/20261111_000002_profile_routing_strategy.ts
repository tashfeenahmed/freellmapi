// Migration: per-profile routing strategy
// Created: 2026-10-25
//
// DOWN: reversible (DROP COLUMN)
//
// routing_strategy is a single global setting, so every chain is ranked by the
// same preset. An operator who wants one chain to be "reliable" (strict JSON
// ingestion that cannot be retried by hand) while another chases "smartest"
// has to serialise them behind one global flip, even though the chains are
// already independent.
//
// This column lets a profile carry its own preset. NULL means "inherit the
// global strategy", so every existing install keeps its current behaviour.
//
// Guarded like every other column add: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'profiles', 'routing_strategy')) {
    db.prepare('ALTER TABLE profiles ADD COLUMN routing_strategy TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'profiles', 'routing_strategy')) {
    db.prepare('ALTER TABLE profiles DROP COLUMN routing_strategy').run();
  }
}
