// Migration: <short description>
// Created: <YYYY-MM-DD>
//
// DOWN: <reversible | irreversible - reason>

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    -- your SQL here
  `);
}

export function down(db: Db): void {
  // If reversible:
  db.exec(`
    -- inverse SQL here
  `);

  // If irreversible:
  // throw new Error('irreversible migration: <reason>');
}
