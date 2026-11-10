// Migration: verification_basis observability column on api_keys (#1516)
// Created: 2026-11-05
//
// DOWN: reversible (DROP COLUMN)
//
// A key can sit at status='healthy' while only ever passing the /models
// catalog probe — many providers return 200 on /models for expired or
// out-of-quota keys and only fail at real chat/completions time (#1516).
// verification_basis records what the healthy verdict actually rests on,
// display-only: 'models_only' when the verdict came from the /models probe,
// 'inference_verified' once the key has served a real request. It changes
// no routing: chain ranking and the suspect-state question stay maintainer
// decisions. NULL means never verified (or cleared by an invalid verdict).
//
// Guarded like every other column add: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'api_keys', 'verification_basis')) {
    db.prepare("ALTER TABLE api_keys ADD COLUMN verification_basis TEXT").run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'api_keys', 'verification_basis')) {
    db.prepare('ALTER TABLE api_keys DROP COLUMN verification_basis').run();
  }
}
