// Migration: tag provider-moment failures on requests (#1347 PR 1)
// Created: 2026-10-17
//
// DOWN: reversible (DROP COLUMN)

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

// #1347 (PR 1): rate-limit-aware failure attribution. A failed attempt whose
// root cause is a provider moment — a 429, a 5xx, a timeout, a dropped socket
// — is evidence about the provider's minute, not the model's quality. When
// the opt-in setting is on, such rows are tagged 'provider_moment' so the
// routing stats can exclude them from the model-level books. NULL (the
// default, and every historical row) means "unattributed" and keeps today's
// scoring behaviour exactly.
export function up(db: Db): void {
  if (!hasColumn(db, 'requests', 'failure_attribution')) {
    db.prepare('ALTER TABLE requests ADD COLUMN failure_attribution TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'requests', 'failure_attribution')) {
    db.prepare('ALTER TABLE requests DROP COLUMN failure_attribution').run();
  }
}
