// Migration: remove the retired GitHub Models provider
// Created: 2026-10-17
//
// DOWN: reversible (the removed rows are kept in settings)
//
// GitHub Models was retired on 30 July 2026 (#549). models.github.ai now
// answers every request with 200 "OK" in plain text, so leftover GitHub keys
// looked healthy, custom GitHub models joined the fallback chain, and every
// request routed there failed (#1557). The adapter is gone, so these rows can
// never serve again: remove the keys, models, embedding and media rows, model
// overrides, and the chain and profile entries that point at the models.
// Request history keeps its 'github' rows; that is a record, not config.

import type { Db } from '../types.js';

const SETTING_KEY = 'migration_github_removed_rows';

type Row = Record<string, unknown>;

// Insert order for DOWN: parents before the rows that reference them.
const TABLES = ['api_keys', 'models', 'embedding_models', 'media_models', 'model_overrides', 'fallback_config', 'profile_models'] as const;
type Table = (typeof TABLES)[number];

function tableExists(db: Db, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function selectRows(db: Db, table: Table): Row[] {
  if (!tableExists(db, table)) return [];
  if (table === 'fallback_config' || table === 'profile_models') {
    return db.prepare(`
      SELECT * FROM ${table} WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'github')
    `).all() as Row[];
  }
  return db.prepare(`SELECT * FROM ${table} WHERE platform = 'github'`).all() as Row[];
}

// Encrypted key columns may be BLOBs; JSON keeps them as tagged base64.
function encode(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = Buffer.isBuffer(v) ? { $buffer: v.toString('base64') } : v;
  }
  return out;
}

function decode(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const tagged = v as { $buffer?: string } | null;
    out[k] = tagged && typeof tagged === 'object' && typeof tagged.$buffer === 'string'
      ? Buffer.from(tagged.$buffer, 'base64')
      : v;
  }
  return out;
}

export function up(db: Db): void {
  const removed: Partial<Record<Table, Row[]>> = {};
  for (const table of TABLES) removed[table] = selectRows(db, table).map(encode);

  // Children first: chain and profile rows reference models(id).
  for (const table of ['fallback_config', 'profile_models'] as const) {
    if (!tableExists(db, table)) continue;
    db.prepare(`
      DELETE FROM ${table} WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'github')
    `).run();
  }
  for (const table of ['models', 'embedding_models', 'media_models', 'model_overrides', 'api_keys'] as const) {
    if (!tableExists(db, table)) continue;
    db.prepare(`DELETE FROM ${table} WHERE platform = 'github'`).run();
  }

  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTING_KEY, JSON.stringify(removed));
}

export function down(db: Db): void {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  const removed: Partial<Record<Table, Row[]>> = row ? JSON.parse(row.value) : {};
  for (const table of TABLES) {
    for (const raw of removed[table] ?? []) {
      const r = decode(raw);
      const cols = Object.keys(r);
      db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map(c => r[c]));
    }
  }
  db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_KEY);
}
