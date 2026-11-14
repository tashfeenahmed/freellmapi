// Migration: remember the chain flags an upstream retirement overwrote
// Created: 2026-11-13
//
// DOWN: reversible — drops the added column. Retirements recorded after the
// up-migration then reinstate the old way (every chain flag back on).

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/**
 * An upstream retirement (#634) switches the model off in the global chain and
 * in every profile. Lifting it used to switch ALL of those back on, including
 * chains the user had switched the model off in. `chain_snapshot` holds the
 * flags as they were at retirement (JSON, see services/model-state.ts) so the
 * lift restores exactly those. NULL for user deletions and for retirements
 * recorded before this column existed, which keep the old lift.
 */
export function up(db: Db): void {
  if (!hasColumn(db, 'catalog_model_tombstones', 'chain_snapshot')) {
    db.prepare('ALTER TABLE catalog_model_tombstones ADD COLUMN chain_snapshot TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'catalog_model_tombstones', 'chain_snapshot')) {
    db.prepare('ALTER TABLE catalog_model_tombstones DROP COLUMN chain_snapshot').run();
  }
}
