import { describe, expect, it } from 'vitest';
import { runMigrations, getMigrationStatuses } from '../../../db/migrate/runner.js';
import { getPostgresPool } from '../../../db/postgres.js';
import { DEFAULT_MIGRATIONS } from '../../../db/migrate/defaults.js';

describe('PostgreSQL migration runner', () => {
  it('runs pending migrations up and records applied files', async () => {
    const pool = getPostgresPool();
    await runMigrations(pool, 'up');

    // Every registered migration must apply — the count is read from the
    // registry so adding one does not mean editing this test.
    const expected = DEFAULT_MIGRATIONS.length;
    const statuses = await getMigrationStatuses(pool);
    expect(statuses.length).toBe(expected);
    expect(statuses.every(s => s.status === 'applied')).toBe(true);

    const res = await pool.query('SELECT filename FROM migrations ORDER BY id ASC');
    expect(res.rows.length).toBe(expected);
  });
});
