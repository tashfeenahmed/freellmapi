// Migration: durable server_logs for the dashboard log viewer
// Created: 2026-08-23
//
// DOWN: reversible
//
// The log viewer reads a 1000-entry in-memory ring, which is the right store
// for a live tail and the wrong one for the question operators actually ask:
// "what went wrong while I was asleep / before this restart?". A ring answers
// that with an empty panel.
//
// So warn and error — and only those — are ALSO written here. Info and debug
// are the volume (a busy gateway prints several lines per request) and the part
// nobody goes looking for after the fact; persisting them would turn a
// diagnostic aid into the database's largest table. The CHECK constraint states
// that policy in the schema rather than leaving it to the writer.
//
// `id` is assigned by the application, NOT by AUTOINCREMENT, because the ring
// and this table share one id space: the client polls with a `sinceId` cursor
// and that cursor has to mean the same thing for a line that only ever lived in
// memory and for one preloaded from here. lib/server-logs.ts seeds its counter
// from MAX(id) at init, which is what keeps ids increasing across restarts.
//
// created_at_ms is epoch milliseconds (like playground_conversations and
// sessions.expires_at_ms): the viewer renders relative times in the browser's
// clock, and sub-second ordering matters when a failure prints five lines at
// once. The index is (created_at_ms, id) — the retention prune's cutoff scan
// and the boot preload's "most recent N" both read exactly that order, with id
// as the tiebreak for lines sharing a millisecond.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_logs (
      id INTEGER PRIMARY KEY,
      level TEXT CHECK(level IN ('warn','error')),
      source TEXT,
      provider TEXT,
      model TEXT,
      event TEXT,
      request_id TEXT,
      message TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_server_logs_created
      ON server_logs(created_at_ms, id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_server_logs_created;
    DROP TABLE IF EXISTS server_logs;
  `);
}
