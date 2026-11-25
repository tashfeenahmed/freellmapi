// Migration: media_models.source provenance (catalog vs user) for the sync delete guard
// Created: 2026-11-25
//
// DOWN: reversible (DROP COLUMN)
//
// The media_models counterpart of 20261118_000001_embedding_source_provenance.ts
// and 20260726_000003_model_source_provenance.ts. catalog-sync prunes media rows
// the signed catalog no longer lists, and before this column it decided which
// rows it owned from the platform alone (membership of MEDIA_PLATFORMS and the
// per-modality platform sets). A media row registered on a NATIVE platform is
// indistinguishable from a catalog row on that test, so the next sync deleted
// it whenever the catalog did not list it.
//
// `source` records who created the row at insert time:
//   'catalog' - catalog sync or the bundled baseline migrations
//   'user'    - the operator, through a user-facing write path
//
// The column DEFAULT is 'catalog' on purpose, mirroring models.source: baseline
// re-seeds must stay catalog-owned so a later sync can prune them. Every
// user-facing write path sets 'user' explicitly.
//
// Backfill, strongest signal first: a row the catalog would never have created
// (custom platform, or bound to a key) is the operator's; failing that, so is a
// row the applied catalog does not list, judged per modality against the same
// snapshot the prune uses.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(candidate => candidate.name === column);
}

type Listing = { platform?: unknown; modelId?: unknown; engineId?: unknown };

function listedKeys(entries: unknown, idField: 'modelId' | 'engineId'): Set<string> | null {
  // Absent or empty snapshot means "leave these rows untouched" (same rule as
  // catalog-sync.ts), so it cannot serve as an authoritative list.
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const keys = new Set<string>();
  for (const e of entries as Listing[]) {
    const id = e?.[idField];
    if (typeof e?.platform === 'string' && typeof id === 'string') keys.add(`${e.platform}:${id}`);
  }
  return keys.size > 0 ? keys : null;
}

export function up(db: Db): void {
  if (!hasColumn(db, 'media_models', 'source')) {
    db.prepare("ALTER TABLE media_models ADD COLUMN source TEXT NOT NULL DEFAULT 'catalog'").run();
  }

  db.prepare(`
    UPDATE media_models
       SET source = 'user'
     WHERE platform = 'custom'
        OR key_id IS NOT NULL
  `).run();

  // Then the applied catalog (settings.catalog_applied_json). Sync prunes
  // catalog-owned leftovers on every apply, so a surviving row the applied
  // catalog does not list was added locally. With no applied catalog every
  // remaining row came from the bundled baseline and the default stands.
  try {
    const setting = db
      .prepare("SELECT value FROM settings WHERE key = 'catalog_applied_json'")
      .get() as { value: string } | undefined;
    if (!setting) return;
    const parsed = JSON.parse(setting.value) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return;

    // Each modality is judged only against the snapshot that governs its prune.
    const models = Array.isArray(parsed.models) ? parsed.models as Listing[] : [];
    const chatMedia = listedKeys(models, 'modelId');
    const snapshots: [string[], Set<string> | null][] = [
      [['image', 'audio'], chatMedia],
      [['video'], listedKeys(parsed.videoModels, 'modelId')],
      [['transcription'], listedKeys(parsed.transcriptionModels, 'modelId')],
      [['search'], listedKeys(parsed.searchEngines, 'engineId')],
      [['decision'], listedKeys(parsed.decisionModels, 'modelId')],
    ];
    const select = db.prepare("SELECT id, platform, model_id FROM media_models WHERE source = 'catalog' AND modality = ?");
    const markUser = db.prepare("UPDATE media_models SET source = 'user' WHERE id = ?");
    for (const [modalities, listed] of snapshots) {
      if (!listed) continue;
      for (const modality of modalities) {
        for (const row of select.all(modality) as { id: number; platform: string; model_id: string }[]) {
          if (!listed.has(`${row.platform}:${row.model_id}`)) markUser.run(row.id);
        }
      }
    }
  } catch {
    // A corrupt cached catalog must not block the migration; rows keep the
    // key_id/platform backfill above.
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'media_models', 'source')) {
    db.prepare('ALTER TABLE media_models DROP COLUMN source').run();
  }
}
