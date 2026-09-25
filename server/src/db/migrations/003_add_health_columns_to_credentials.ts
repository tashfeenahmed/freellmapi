import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE credentials
    ADD COLUMN IF NOT EXISTS last_health_error TEXT DEFAULT NULL
  `);
  await client.query(`
    ALTER TABLE credentials
    ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ DEFAULT NULL
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE credentials
    DROP COLUMN IF EXISTS last_health_error,
    DROP COLUMN IF EXISTS last_checked_at
  `);
}
