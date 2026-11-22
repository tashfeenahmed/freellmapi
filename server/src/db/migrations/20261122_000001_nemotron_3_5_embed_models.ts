// Migration: add NVIDIA Nemotron 3.5 embedding models to the catalog (#1979)
// Created: 2026-11-22
//
// DOWN: reversible (deletes exactly the two rows UP inserts)
//
// `nvidia/nemotron-3.5-embed-1b` and `nvidia/nemotron-3.5-embed-8b` are live
// on NVIDIA's API but missing from the embedding catalog, so they cannot be
// selected in the dashboard. The reporter live-probed both models (#1979):
// native dimension 2048, and — unlike Nemotron 3 — the 3.5 family accepts
// server-side `dimensions` truncation (1536/1024/512, L2-normalised).
//
// No adapter work is needed: the native `nvidia` branch of callProvider in
// services/embeddings.ts already sends `input_type: 'query'` (required by
// these asymmetric models) and forwards a caller-supplied `dimensions`
// override. The missing piece is only the catalog rows.
//
// INSERT OR IGNORE mirrors the baseline seed in the legacy baseline
// migration and keeps this idempotent: catalog-sync re-runs migrations over
// a live schema, and the UNIQUE(platform, model_id) constraint makes a
// second run a no-op.
//
// IDs are assigned explicitly (MAX(id) + 1, +2) rather than left to
// AUTOINCREMENT so a down/up round trip restores the exact same rows: after
// DOWN deletes them, a plain re-insert would hand out fresh IDs and the
// restored catalog would differ from the original in every row's id.

import type { Db } from '../types.js';

const ROWS: Array<[string, string, string, string, number, number, number, number, string]> = [
  // family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label
  ['nemotron-3.5-embed-1b', 'nvidia', 'nvidia/nemotron-3.5-embed-1b', 'Nemotron 3.5 Embed 1B', 2048, 4096, 1, 1, '~40 rpm'],
  ['nemotron-3.5-embed-8b', 'nvidia', 'nvidia/nemotron-3.5-embed-8b', 'Nemotron 3.5 Embed 8B', 2048, 4096, 1, 1, '~40 rpm'],
];

export function up(db: Db): void {
  const seed = db.prepare(`
    INSERT OR IGNORE INTO embedding_models
      (id, family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const apply = db.transaction(() => {
    const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM embedding_models').get() as { maxId: number };
    let nextId = max.maxId + 1;
    for (const r of ROWS) seed.run(nextId++, ...r);
  });
  apply();
}

export function down(db: Db): void {
  const remove = db.prepare('DELETE FROM embedding_models WHERE platform = ? AND model_id = ?');
  const apply = db.transaction(() => { for (const r of ROWS) remove.run(r[1], r[2]); });
  apply();
}
