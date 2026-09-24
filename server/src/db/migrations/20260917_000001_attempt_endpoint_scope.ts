import type { Db } from '../types.js';

/**
 * Migration: request_attempts.endpoint_scope — the endpoint identity the
 * attempt ran against (#1254).
 *
 * Attempt rows already carry (platform, model_id), but a custom relay model is
 * one `models` row per relay (`models.endpoint_scope`, #651): two relays
 * serving the same model id are indistinguishable in the attempt trail today.
 * Endpoint-level failure attribution — the prerequisite for the endpoint
 * health state machine in #1254 — needs to know WHICH relay died.
 *
 * Stores the same scope token as `models.endpoint_scope`: '' for catalog
 * platforms, the normalized base_url for custom relays. Nullable-add keeps
 * pre-existing rows with NULL; readers treat NULL and '' alike ("not
 * endpoint-scoped / unknown").
 */
export function up(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(request_attempts)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === 'endpoint_scope')) {
    db.prepare('ALTER TABLE request_attempts ADD COLUMN endpoint_scope TEXT').run();
  }
}

export function down(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(request_attempts)`).all() as { name: string }[];
  if (columns.some((c) => c.name === 'endpoint_scope')) {
    db.prepare('ALTER TABLE request_attempts DROP COLUMN endpoint_scope').run();
  }
}
