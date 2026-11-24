// Migration: per-model input_type for custom embedding endpoints
// Created: 2026-11-17
//
// DOWN: reversible (DROP COLUMN)
//
// Asymmetric embedding models — NVIDIA's Nemotron 3.5 family, for one —
// separate the "what the user is asking" side from the "what is stored in the
// index" side, and the provider refuses to guess:
//   HTTP 400 "'input_type' parameter is required for asymmetric models"
// The native nvidia adapter has always sent input_type: 'query' for that
// reason, but a CUSTOM endpoint had no way to say it: the request path and
// the dimension probe both went out with no input_type, so an operator could
// not even REGISTER such a model (the probe failed with the upstream 400).
//
// This column stores the operator's choice per embedding model. NULL means
// "no opinion": the request goes out exactly as it did before, which is what
// symmetric models (bge-m3, text-embedding-3-*) want. Only a custom row that
// was explicitly registered with an input_type sends one.
//
// Guarded like every other column add: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'embedding_models', 'input_type')) {
    db.prepare('ALTER TABLE embedding_models ADD COLUMN input_type TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'embedding_models', 'input_type')) {
    db.prepare('ALTER TABLE embedding_models DROP COLUMN input_type').run();
  }
}
