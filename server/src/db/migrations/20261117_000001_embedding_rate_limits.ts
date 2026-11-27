// Migration: per-model rate-limit windows on embedding_models
// Created: 2026-11-17
//
// DOWN: reversible (DROP COLUMN)
//
// The chat `models` table has carried rpm_limit / rpd_limit / tpm_limit /
// tpd_limit since the beginning; `embedding_models` never got them, so the
// whole embeddings path bypassed every window the chat router enforces
// (services/ratelimit.ts canMakeRequest / canUseTokens). An embedding row
// could therefore keep dispatching until the PROVIDER answered 429, and the
// gateway had no usage of its own to reason with.
//
// The provider-wide per-minute cap (NVIDIA NIM meters ~40 requests/minute
// ACCOUNT-wide, DEFAULT_PROVIDER_MINUTE_REQUEST_CAPS in services/ratelimit.ts)
// covers only part of that gap: it is keyed on platform + key, so it cannot
// express a limit that belongs to one embedding model. These four columns
// carry the per-model half.
//
// All four are NULL by default, which means "no opinion" — exactly like the
// models table, so a catalog (or an operator registering a custom endpoint)
// opts a row into a window, and a row nobody configured behaves as before.
//
// Guarded like every other column add: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

const LIMIT_COLUMNS = ['rpm_limit', 'rpd_limit', 'tpm_limit', 'tpd_limit'] as const;

export function up(db: Db): void {
  for (const column of LIMIT_COLUMNS) {
    if (!hasColumn(db, 'embedding_models', column)) {
      db.prepare(`ALTER TABLE embedding_models ADD COLUMN ${column} INTEGER`).run();
    }
  }
}

export function down(db: Db): void {
  // Reverse order, so a down() after an up() leaves the table exactly as the
  // baseline created it (SQLite appends columns at the end).
  for (const column of [...LIMIT_COLUMNS].reverse()) {
    if (hasColumn(db, 'embedding_models', column)) {
      db.prepare(`ALTER TABLE embedding_models DROP COLUMN ${column}`).run();
    }
  }
}
