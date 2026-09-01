import type { Db } from '../types.js';

const COLUMNS = [
  ['provider_rpm_limit', 'INTEGER'],
  ['provider_rpd_limit', 'INTEGER'],
  ['provider_tpd_limit', 'INTEGER'],
] as const;

function hasColumn(db: Db, column: string): boolean {
  const columns = db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[];
  return columns.some(candidate => candidate.name === column);
}

export function up(db: Db): void {
  for (const [column, type] of COLUMNS) {
    if (!hasColumn(db, column)) db.prepare(`ALTER TABLE api_keys ADD COLUMN ${column} ${type}`).run();
  }
}

export function down(db: Db): void {
  for (const [column] of [...COLUMNS].reverse()) {
    if (hasColumn(db, column)) db.prepare(`ALTER TABLE api_keys DROP COLUMN ${column}`).run();
  }
}
