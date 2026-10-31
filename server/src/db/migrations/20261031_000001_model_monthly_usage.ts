import type { Db } from '../types.js';

/** Keep the monthly chat budget display accurate after raw analytics are pruned. */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_monthly_usage (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      month TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (platform, model_id, month)
    );
    INSERT INTO model_monthly_usage (platform, model_id, month, tokens)
    SELECT platform, model_id, strftime('%Y-%m', created_at),
           SUM(input_tokens + output_tokens)
      FROM requests
     WHERE request_type = 'chat'
       AND strftime('%Y-%m', created_at) IS NOT NULL
     GROUP BY platform, model_id, strftime('%Y-%m', created_at)
    ON CONFLICT(platform, model_id, month) DO NOTHING;

    CREATE TRIGGER IF NOT EXISTS requests_model_monthly_usage
    AFTER INSERT ON requests
    WHEN NEW.request_type = 'chat'
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

export function down(db: Db): void {
  db.exec('DROP TRIGGER IF EXISTS requests_model_monthly_usage; DROP TABLE IF EXISTS model_monthly_usage;');
}
