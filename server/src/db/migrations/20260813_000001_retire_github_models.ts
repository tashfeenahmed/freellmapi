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
  // Restore the GitHub Models rows the legacy baseline seeded, so a migration
  // round-trip (up → down → up) can reproduce the pre-retirement catalog —
  // the round-trip test requires every down() to actually alter app state.
  // A fresh install's only github rows are the baseline's, so restoring those
  // two is a faithful inverse of up().
  const insert = db.prepare(`
    INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES ('github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addedIds: number[] = [];
  // Baseline seed rows (legacy_baseline.ts): openai/gpt-5 (V14 rename of the
  // original gpt-4o row) and openai/gpt-4.1 with their catalog limits.
  const seed: [string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null][] = [
    ['openai/gpt-5', 'GPT-5 (GitHub)', 1, 7, 'Frontier', 10, 50, null, null, '~18M', 128000],
    ['openai/gpt-4.1', 'GPT-4.1 (GitHub)', 20, 7, 'Large', 10, 50, null, null, '~9M', 8000],
  ];
  for (const [modelId, displayName, ir, sr, size, rpm, rpd, tpm, tpd, budget, ctx] of seed) {
    const res = insert.run(modelId, displayName, ir, sr, size, rpm, rpd, tpm, tpd, budget, ctx);
    addedIds.push(Number(res.lastInsertRowid));
  }
  // Re-append to the fallback chain, mirroring the baseline's missing-model
  // backfill so the restored rows are routable again.
  const max = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number }).m;
  const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  for (let i = 0; i < addedIds.length; i++) addFb.run(addedIds[i], max + i + 1);
}
