// Migration: embedding_models.source provenance (catalog vs user) for the sync delete guard
// Created: 2026-11-18
//
// DOWN: reversible (DROP COLUMN)
//
// This is the embedding_models counterpart of
// 20260726_000003_model_source_provenance.ts, which gave the chat `models`
// table the same column. The chat table needed it because catalog-sync prunes
// chat models the published catalog no longer lists, and before the column
// that prune had to GUESS which rows it owned from platform/key_id/size_label
// heuristics — so a hand-added model on a native platform could be silently
// deleted the moment its size_label stopped matching the 'User'/'Custom'
// convention.
//
// The embeddings table had the same hole, and worse: it has no size_label at
// all, so the prune could only fall back on `platform != 'custom' AND
// key_id IS NULL`. An embedding model registered on a NATIVE platform
// (platform='nvidia') therefore looked exactly like a catalog-owned row and
// was deleted on the next sync if the signed catalog did not list it.
//
// Live case: nvidia/nemotron-3.5-embed-1b was registered on the native nvidia
// platform because NVIDIA's 3.5 family is asymmetric and rejects the custom
// registration probe with HTTP 400 "'input_type' parameter is required for
// asymmetric models" — so the custom route could not create it. It worked,
// served traffic, and was silently deleted by the next catalog sync because
// the catalog (which does not yet list the 3.5 family) did not know about it.
//
// `source` records who created the row at insert time:
//   'catalog' — catalog sync or the bundled baseline migrations
//   'user'    — the operator, through any user-facing write path
//
// The column DEFAULT is 'catalog' on purpose, mirroring models.source: the
// baseline migration's INSERT OR IGNORE re-seeds (run on every fresh
// migrations table) must stay catalog-owned so reapplyCachedCatalog can prune
// them again after boot. Every user-facing write path sets 'user' explicitly.
//
// Backfill mirrors the chat migration: strongest signal first. A row the
// operator owns is one the catalog would never have created — a custom
// platform, or one bound to a key — and, failing that, one the applied
// catalog does not list.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(candidate => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'embedding_models', 'source')) {
    db.prepare("ALTER TABLE embedding_models ADD COLUMN source TEXT NOT NULL DEFAULT 'catalog'").run();
  }

  // Backfill pre-existing rows, strongest signal first: everything the old
  // prune guard already treated as user-owned is user-owned.
  db.prepare(`
    UPDATE embedding_models
       SET source = 'user'
     WHERE platform = 'custom'
        OR key_id IS NOT NULL
  `).run();

  // Then consult the currently-applied catalog (the signed document cached by
  // catalog-sync in settings.catalog_applied_json). A surviving row that the
  // applied catalog does not list — and that the heuristics above did not
  // claim — can only have been added locally: sync prunes catalog-owned
  // leftovers on every apply, so catalog rows absent from the catalog do not
  // linger. With no applied catalog (fresh install, never synced) every
  // remaining row came from the bundled baseline, so the 'catalog' default
  // stands.
  try {
    const setting = db
      .prepare("SELECT value FROM settings WHERE key = 'catalog_applied_json'")
      .get() as { value: string } | undefined;
    if (!setting) return;
    const parsed = JSON.parse(setting.value) as { embeddings?: unknown };
    if (!parsed || !Array.isArray(parsed.embeddings)) return;
    const inCatalog = new Set<string>();
    for (const e of parsed.embeddings as { platform?: unknown; modelId?: unknown }[]) {
      if (typeof e?.platform === 'string' && typeof e?.modelId === 'string') {
        inCatalog.add(`${e.platform}:${e.modelId}`);
      }
    }
    const rows = db
      .prepare("SELECT id, platform, model_id FROM embedding_models WHERE source = 'catalog'")
      .all() as { id: number; platform: string; model_id: string }[];
    const markUser = db.prepare("UPDATE embedding_models SET source = 'user' WHERE id = ?");
    for (const row of rows) {
      if (!inCatalog.has(`${row.platform}:${row.model_id}`)) markUser.run(row.id);
    }
  } catch {
    // A corrupt cached catalog must not block the migration; rows keep the
    // heuristic-based backfill above, which errs on the side the old guard
    // already enforced.
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'embedding_models', 'source')) {
    db.prepare('ALTER TABLE embedding_models DROP COLUMN source').run();
  }
}
