import { describe, expect, it } from 'vitest';
import { getPostgresPool } from '../../../db/postgres.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import {
  INITIAL_SCHEMA_FILENAME,
  SEED_PROVIDERS_MODELS_FILENAME,
  ADD_HEALTH_COLUMNS_FILENAME,
  FIX_SETTINGS_UPDATED_AT_FILENAME,
  ADD_MISSING_MODEL_COLUMNS_FILENAME,
  COMPAT_TABLES_FILENAME,
  DEFAULT_MIGRATIONS,
} from '../../../db/migrate/defaults.js';

describe('PostgreSQL migration runner', () => {
  it('runs all PostgreSQL migrations up, checks status, and verifies default schema', async () => {
    const pool = getPostgresPool();

    await runMigrations(pool, 'up');

    const statuses = await getMigrationStatuses(pool);
    expect(statuses.length).toBe(DEFAULT_MIGRATIONS.length);
    expect(statuses.every(s => s.status === 'applied')).toBe(true);

    expect(statuses.map(s => s.filename)).toEqual([
      INITIAL_SCHEMA_FILENAME,
      SEED_PROVIDERS_MODELS_FILENAME,
      ADD_HEALTH_COLUMNS_FILENAME,
      FIX_SETTINGS_UPDATED_AT_FILENAME,
      ADD_MISSING_MODEL_COLUMNS_FILENAME,
      COMPAT_TABLES_FILENAME,
    ]);

    // Verify providers seeded
    const providersRes = await pool.query('SELECT COUNT(*) as c FROM providers');
    expect(Number(providersRes.rows[0]?.c ?? 0)).toBeGreaterThan(0);
  });
});
