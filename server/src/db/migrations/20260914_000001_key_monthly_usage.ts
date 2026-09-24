import type { Db } from '../types.js';

/** A durable ledger: pruning analytics must never reopen a spent monthly cap. */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS key_monthly_usage (
      key_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_id, month)
    );
    INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
    SELECT key_id, strftime('%Y-%m', created_at), COUNT(*),
           SUM(MAX(0, input_tokens) + MAX(0, output_tokens))
      FROM requests
     WHERE key_id IS NOT NULL AND status = 'success'
       AND strftime('%Y-%m', created_at) IS NOT NULL
     GROUP BY key_id, strftime('%Y-%m', created_at)
    ON CONFLICT(key_id, month) DO NOTHING;

    CREATE TRIGGER IF NOT EXISTS requests_key_monthly_usage
    AFTER INSERT ON requests
    WHEN NEW.key_id IS NOT NULL AND NEW.status = 'success'
      AND strftime('%Y-%m', NEW.created_at) IS NOT NULL
    BEGIN
      INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
      VALUES (NEW.key_id, strftime('%Y-%m', NEW.created_at), 1,
              MAX(0, NEW.input_tokens) + MAX(0, NEW.output_tokens))
      ON CONFLICT(key_id, month) DO UPDATE SET
        requests = requests + 1,
        tokens = tokens + excluded.tokens;
    END;
  `);
}

export function down(db: Db): void {
  db.exec('DROP TRIGGER IF EXISTS requests_key_monthly_usage; DROP TABLE IF EXISTS key_monthly_usage;');
}
