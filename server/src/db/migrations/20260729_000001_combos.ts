// Migration: Create combos table for named model groups
// Created: 2026-07-29
//
// DOWN: reversible

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS combos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      models TEXT NOT NULL DEFAULT '[]',
      strategy TEXT NOT NULL DEFAULT 'fallback' CHECK (strategy IN ('fallback', 'round-robin', 'fusion')),
      sticky_limit INTEGER NOT NULL DEFAULT 1,
      judge_model TEXT,
      kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'fusion')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_combos_name ON combos(name);
  `);
}

export function down(db: Db): void {
  db.exec(`DROP TABLE IF EXISTS combos;`);
}
