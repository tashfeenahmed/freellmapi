// Migration: custom_key_bindings junction table (model-level key isolation)
// Created: 2026-07-07
//
// Adds a many-to-many table binding custom models (chat / embedding / media) to
// the api_keys rows they may route through. Previously a custom model carried a
// single key_id anchor and the router treated every key sharing its base_url as
// usable — which pooled keys across all models on an endpoint and broke
// isolation (a finance model could burn a research key's quota).
//
// The junction table makes "which keys can serve this model" explicit data:
// registration writes a binding; routing reads bindings; deletion removes the
// binding and only cascades a model/key when its last binding is gone.
//
// Existing models.key_id values are backfilled as their sole binding, so single
// -key installs upgrade transparently (one binding per model == old behaviour).
//
// DOWN: reversible

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_key_bindings (
      modality     TEXT NOT NULL,
      model_db_id  INTEGER NOT NULL,
      key_id       INTEGER NOT NULL,
      PRIMARY KEY (modality, model_db_id, key_id)
    );
    CREATE INDEX IF NOT EXISTS idx_custom_key_bindings_key ON custom_key_bindings(key_id);

    -- Backfill existing custom model anchors as their (sole) binding.
    INSERT OR IGNORE INTO custom_key_bindings (modality, model_db_id, key_id)
      SELECT 'chat', id, key_id FROM models
       WHERE platform = 'custom' AND key_id IS NOT NULL;
    INSERT OR IGNORE INTO custom_key_bindings (modality, model_db_id, key_id)
      SELECT 'embedding', id, key_id FROM embedding_models
       WHERE platform = 'custom' AND key_id IS NOT NULL;
    INSERT OR IGNORE INTO custom_key_bindings (modality, model_db_id, key_id)
      SELECT modality, id, key_id FROM media_models
       WHERE platform = 'custom' AND key_id IS NOT NULL;
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS custom_key_bindings;
  `);
}
