// Migration: caller dimension on request analytics
// Created: 2026-09-01
//
// DOWN: reversible
//
// Request log rows (requests table) gain a `caller` column so self-hosters can
// tell which pathway produced a request: 'http' (OpenAI-compatible endpoints),
// 'mcp' (/mcp JSON-RPC), or 'web' (dashboard API). Pairs with the top-level
// `execution_id` on response bodies (see routes/proxy.ts) — given an id from a
// client error you can look up the row and see its caller at a glance.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const row = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return row.some(c => c.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'requests', 'caller')) {
    db.prepare('ALTER TABLE requests ADD COLUMN caller TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'requests', 'caller')) {
    db.prepare('ALTER TABLE requests DROP COLUMN caller').run();
  }
}
