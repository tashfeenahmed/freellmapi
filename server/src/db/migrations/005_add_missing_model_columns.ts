import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE models
    ADD COLUMN IF NOT EXISTS intelligence_rank INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS speed_rank INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS size_label VARCHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS rpm_limit INTEGER DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS rpd_limit INTEGER DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS tpm_limit INTEGER DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS tpd_limit INTEGER DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS monthly_token_budget VARCHAR(128) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS key_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS endpoint_scope TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS paid_input_per_m NUMERIC(10, 6) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS paid_output_per_m NUMERIC(10, 6) DEFAULT NULL;
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE models
    DROP COLUMN IF EXISTS intelligence_rank,
    DROP COLUMN IF EXISTS speed_rank,
    DROP COLUMN IF EXISTS size_label,
    DROP COLUMN IF EXISTS rpm_limit,
    DROP COLUMN IF EXISTS rpd_limit,
    DROP COLUMN IF EXISTS tpm_limit,
    DROP COLUMN IF EXISTS tpd_limit,
    DROP COLUMN IF EXISTS monthly_token_budget,
    DROP COLUMN IF EXISTS key_id,
    DROP COLUMN IF EXISTS endpoint_scope,
    DROP COLUMN IF EXISTS paid_input_per_m,
    DROP COLUMN IF EXISTS paid_output_per_m;
  `);
}
