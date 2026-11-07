// Migration: Cloudflare Workers AI neuron ledger
// Created: 2026-11-04
//
// DOWN: reversible (drops cloudflare_neuron_usage)
//
// Workers AI meters 10,000 free neurons per day per ACCOUNT. On the Free plan
// Cloudflare answers a 429 once they are gone; on Workers Paid it never does,
// it bills the overage instead. So FreeLLMAPI meters neurons itself, at
// dispatch time, in this ledger (services/cloudflare-neurons.ts): one row per
// UTC day, account and model, charged with an estimate when a call goes out
// and corrected to the real usage when it completes. A call that aborts or
// times out keeps its estimate, because Cloudflare bills work it started.
//
// remote_neurons holds Cloudflare's own count for the account and day when the
// key's token may read account analytics (model_id = '' row), so usage from
// outside this install counts too.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloudflare_neuron_usage (
      day TEXT NOT NULL,
      account_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      settled_calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      neurons REAL NOT NULL DEFAULT 0,
      remote_neurons REAL,
      remote_checked_at_ms INTEGER,
      PRIMARY KEY (day, account_id, model_id)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS cloudflare_neuron_usage;');
}
