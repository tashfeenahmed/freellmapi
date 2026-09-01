import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/** Per-chain opt-out from the catalog-sync backfill (#895).
 *
 *  Every profile used to be a copy of the whole catalog, and `ensureAllModelsInProfiles`
 *  put each newly synced model into every profile. That is right for a chain
 *  the user never pruned, and wrong for one they curated by hand: the next
 *  catalog sync silently pushed a dozen models back into it.
 *
 *  1 (the default, and what every existing chain gets) keeps the old behaviour.
 *  A chain created with `empty: true` starts at 0, so it only ever holds what
 *  the user put in it. */
export function up(db: Db): void {
  if (!hasColumn(db, 'profiles', 'auto_include_new_models')) {
    db.prepare('ALTER TABLE profiles ADD COLUMN auto_include_new_models INTEGER NOT NULL DEFAULT 1').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'profiles', 'auto_include_new_models')) {
    db.prepare('ALTER TABLE profiles DROP COLUMN auto_include_new_models').run();
  }
}
