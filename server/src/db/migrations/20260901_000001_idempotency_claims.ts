// Migration: idempotency claims for HTTP Idempotency-Key support
// Created: 2026-09-01
//
// DOWN: reversible
//
// Free-tier quota is a scarce asset: a client that times out and retries the
// same non-streaming chat request currently burns a second free-tier slot for
// an answer it already got. This table lets callers opt in to idempotent
// retries via the `Idempotency-Key` header (see services/idempotency.ts):
//
//   - Only a SHA-256 hash of the caller's key is stored — never the raw key,
//     mirroring how the runtime treats admin/runtime tokens.
//   - request_fingerprint is a canonical SHA-256 of the (model, messages,
//     sampling params) that produced the response, so the same key reused
//     with different content is a conflict (409), not a silent wrong answer.
//   - On success the original HTTP status + body are persisted for replay
//     within the configured window (IDEMPOTENCY_TTL_MS, default 24h). Expired
//     rows are deleted lazily on the next lookup for the same key hash.
//
// Single-user runtime: no user scoping needed. One row per key hash; a new
// claim with the same hash after the previous one completed replaces it.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      execution_id TEXT,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );

    -- The only lookup is by key hash; expiry sweeps scan expires_at.
    CREATE INDEX IF NOT EXISTS idx_idempotency_claims_expires
      ON idempotency_claims(expires_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_idempotency_claims_expires;
    DROP TABLE IF EXISTS idempotency_claims;
  `);
}
