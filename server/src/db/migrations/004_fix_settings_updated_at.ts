import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'settings'
      ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'updated_at'
      ) THEN
        ALTER TABLE settings
        ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      END IF;
    END $$;
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE settings
    DROP COLUMN IF EXISTS updated_at
  `);
}
