import type { Db } from '../types.js';

/** Guard so the migration can be re-run safely (catalog-sync test does this). */
function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  // Tables and indexes are CREATE IF NOT EXISTS — safe to re-run.
  db.exec(`
    -- Tenants: each tenant is an isolated "virtual user" with its own API key,
    -- rate limits, and usage tracking. The admin creates tenants; each gets a
    -- unique key prefixed with "freetenant-" that resolves through resolveAuth.
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      system_prompt TEXT,
      max_rpm INTEGER NOT NULL DEFAULT 0,       -- 0 = no limit
      max_rpd INTEGER NOT NULL DEFAULT 0,
      max_tpm INTEGER NOT NULL DEFAULT 0,
      allowed_models TEXT,                       -- NULL = all; comma-separated model IDs to restrict
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-tenant usage tracking (aggregated from the requests table).
    -- This is a materialized summary updated on each request; the raw data
    -- lives in the requests table with tenant_id as a foreign key.
    CREATE TABLE IF NOT EXISTS tenant_usage (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      period TEXT NOT NULL,                       -- 'YYYY-MM-DD' for daily, 'YYYY-MM' for monthly
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, period)
    );

    CREATE INDEX IF NOT EXISTS idx_tenants_token_hash ON tenants(token_hash);
    CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant ON tenant_usage(tenant_id, period);
  `);

  // Column adds must be guarded: catalog-sync.test.ts deletes non-baseline
  // migration records and re-runs `up`, so this ALTER would throw on a second
  // run if the column already exists.
  if (!hasColumn(db, 'requests', 'tenant_id')) {
    db.prepare('ALTER TABLE requests ADD COLUMN tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL').run();
  }
  // Recreate the index after the column is guaranteed to exist (or already
  // existed from a prior run). DROP FIRST so re-runs don't hit "index exists".
  db.prepare('DROP INDEX IF EXISTS idx_requests_tenant').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_tenant ON requests(tenant_id)').run();
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_requests_tenant;
    DROP INDEX IF EXISTS idx_tenant_usage_tenant;
    DROP INDEX IF EXISTS idx_tenants_token_hash;
    DROP TABLE IF EXISTS tenant_usage;
    DROP TABLE IF EXISTS tenants;
  `);
  // Remove the column we added, if it still exists. Use a prepared statement
  // with error suppression because on legacy baseline DBs the column was never
  // added (the migration would not have run) and the ALTER would otherwise fail.
  try {
    db.prepare('ALTER TABLE requests DROP COLUMN tenant_id').run();
  } catch {
    // Column already gone — nothing to undo.
  }
}
