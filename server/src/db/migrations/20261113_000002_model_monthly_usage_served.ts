// Migration: count only served chat tokens in the monthly usage ledger
// Created: 2026-11-13
//
// The ledger (#1782) keeps the dashboard's monthly budget bar correct after
// request-log retention prunes raw rows. Its trigger counted every chat row,
// so a 429 that logged 900 prompt tokens and served nothing filled the bar.
// This narrows it to the router's served-token definition (cd94f9db): a
// success, or a failure that streamed some output. Rows already in the ledger
// are left as they are; the raw rows they came from may be gone.
//
// DOWN: reversible — restores the trigger that counts every chat row.

import type { Db } from '../types.js';

function createTrigger(db: Db, servedOnly: boolean): void {
  db.exec(`
    DROP TRIGGER IF EXISTS requests_model_monthly_usage;
    CREATE TRIGGER requests_model_monthly_usage
    AFTER INSERT ON requests
    WHEN NEW.request_type = 'chat'
      ${servedOnly ? "AND (NEW.status = 'success' OR NEW.output_tokens > 0)" : ''}
      AND strftime('%Y-%m', NEW.created_at) IS NOT NULL
    BEGIN
      INSERT INTO model_monthly_usage (platform, model_id, month, tokens)
      VALUES (NEW.platform, NEW.model_id, strftime('%Y-%m', NEW.created_at),
              NEW.input_tokens + NEW.output_tokens)
      ON CONFLICT(platform, model_id, month) DO UPDATE SET
        tokens = tokens + excluded.tokens;
    END;
  `);
}

export function up(db: Db): void {
  createTrigger(db, true);
}

export function down(db: Db): void {
  createTrigger(db, false);
}
