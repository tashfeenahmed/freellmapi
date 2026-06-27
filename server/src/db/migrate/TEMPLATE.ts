// Migration: <short description>
// Created: <YYYY-MM-DD>
//
// DOWN: <reversible | irreversible - reason>

import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  db.exec(`
    -- your SQL here
  `);
}

export function down(db: Database.Database): void {
  // If reversible:
  db.exec(`
    -- inverse SQL here
  `);

  // If irreversible:
  // throw new Error('irreversible migration: <reason>');
}
