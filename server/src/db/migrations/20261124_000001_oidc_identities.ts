// Migration: OIDC identity links, passwordless user flag, and session auth metadata (#2008)
// Created: 2026-11-24
//
// DOWN: reversible (DROP TABLE + DROP COLUMN)

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_oidc_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (issuer, subject)
    )
  `).run();
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_user_oidc_identities_user
      ON user_oidc_identities(user_id)
  `).run();

  if (!hasColumn(db, 'users', 'has_local_password')) {
    db.prepare('ALTER TABLE users ADD COLUMN has_local_password INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!hasColumn(db, 'sessions', 'auth_source')) {
    db.prepare("ALTER TABLE sessions ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'password'").run();
  }
  if (!hasColumn(db, 'sessions', 'reauthenticated_at_ms')) {
    db.prepare('ALTER TABLE sessions ADD COLUMN reauthenticated_at_ms INTEGER').run();
  }
}

export function down(db: Db): void {
  db.prepare('DROP INDEX IF EXISTS idx_user_oidc_identities_user').run();
  db.prepare('DROP TABLE IF EXISTS user_oidc_identities').run();
  if (hasColumn(db, 'sessions', 'reauthenticated_at_ms')) {
    db.prepare('ALTER TABLE sessions DROP COLUMN reauthenticated_at_ms').run();
  }
  if (hasColumn(db, 'sessions', 'auth_source')) {
    db.prepare('ALTER TABLE sessions DROP COLUMN auth_source').run();
  }
  if (hasColumn(db, 'users', 'has_local_password')) {
    db.prepare('ALTER TABLE users DROP COLUMN has_local_password').run();
  }
}
