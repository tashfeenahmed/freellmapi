import type { Db } from '../types.js';

/**
 * GitHub Models was retired upstream in August 2026 (#877): the service no
 * longer exists, so the platform is removed from providers/index.ts and the
 * Platform union. This migration deletes the leftover rows a fresh install
 * seeded (and an existing install may still hold) — models, their fallback
 * chain entries, and any keys — mirroring how SambaNova/chutes were dropped
 * in V23.
 */
export function up(db: Db): void {
  const modelRows = db.prepare(`SELECT id FROM models WHERE platform = 'github'`).all() as { id: number }[];
  const deleteChain = db.prepare(`DELETE FROM fallback_config WHERE model_db_id = ?`);
  for (const row of modelRows) deleteChain.run(row.id);
  db.prepare(`DELETE FROM models WHERE platform = 'github'`).run();
  db.prepare(`DELETE FROM api_keys WHERE platform = 'github'`).run();
}

export function down(db: Db): void {
  // The GitHub platform is gone upstream; re-seeding its catalog rows here
  // would resurrect dead routes on an unregister. Nothing to restore.
}
