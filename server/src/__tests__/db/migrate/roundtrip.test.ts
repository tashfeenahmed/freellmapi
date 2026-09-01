import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { connectDb } from '../../../db/index.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';

const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';
const CATALOG_MODEL_STATE_FILENAME = '20260627_000002_catalog_model_state.ts';
const REQUEST_AGGREGATES_FILENAME = '20260628_120000_request_aggregates.ts';
const GITHUB_GPT41_CONTEXT_FILENAME = '20260630_000001_github_gpt41_context.ts';
const REQUEST_CLIENT_INFO_FILENAME = '20260706_000001_request_client_info.ts';
const CUSTOM_MODEL_TOOL_SUPPORT_FILENAME = '20260706_000002_custom_model_tool_support.ts';
const PROFILE_CHAIN_BACKFILL_FILENAME = '20260714_000001_profile_chain_backfill.ts';
const KEY_HEALTH_ERROR_FILENAME = '20260720_000001_key_health_error.ts';
const COOLDOWN_PROBE_PROVENANCE_FILENAME = '20260726_000001_cooldown_probe_provenance.ts';
const REQUEST_ATTEMPTS_FILENAME = '20260726_000002_request_attempts.ts';
const MODEL_SOURCE_PROVENANCE_FILENAME = '20260726_000003_model_source_provenance.ts';
const MEDIA_MODEL_META_FILENAME = '20260726_000004_media_model_meta.ts';
const REQUEST_SERVED_MODEL_FILENAME = '20260726_000005_request_served_model.ts';
const ATTEMPT_ERROR_SUMMARY_FILENAME = '20260726_000006_attempt_error_summary.ts';
const AGENT_COMPATIBILITY_FILENAME = '20260727_000001_agent_compatibility.ts';
const TOMBSTONE_PROVENANCE_FILENAME = '20260728_000001_tombstone_provenance.ts';
const CUSTOM_MODEL_ENDPOINT_IDENTITY_FILENAME = '20260729_000001_custom_model_endpoint_identity.ts';
const CUSTOM_ENDPOINT_HOST_LABELS_FILENAME = '20260802_000001_custom_endpoint_host_labels.ts';
const KEY_MODEL_SCOPE_FILENAME = '20260805_000001_key_model_scope.ts';
const CLIENT_PROFILES_FILENAME = '20260805_000002_client_profiles.ts';
const API_KEY_PROXY_FILENAME = '20260810_000001_api_key_proxy.ts';
const PLAYGROUND_CONVERSATIONS_FILENAME = '20260820_000001_playground_conversations.ts';
const CUSTOM_MODEL_TOMBSTONES_FILENAME = '20260819_000001_custom_model_tombstones.ts';
const SERVER_LOGS_FILENAME = '20260823_000001_server_logs.ts';
const BACKUPS_TABLE_FILENAME = '20260823_000002_backups_table.ts';
const ATTEMPT_KEY_LABEL_FILENAME = '20260823_000003_attempt_key_label.ts';
const PROFILE_AUTO_INCLUDE_FILENAME = '20260823_000004_profile_auto_include.ts';
const IDEMPOTENCY_CLAIMS_FILENAME = '20260901_000001_idempotency_claims.ts';
const QUOTA_OBSERVATION_LOOKUP_FILENAME = '20260901_000002_quota_observation_lookup.ts';

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface DatabaseSnapshot {
  schema: SchemaRow[];
  rows: Record<string, unknown[]>;
}

describe('migration round trip', () => {
  it('connectDb opens a connection without applying migrations', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const db = connectDb(':memory:');

    try {
      expect(hasTable(db, 'models')).toBe(false);
      expect(hasTable(db, 'migrations')).toBe(false);
    } finally {
      db.close();
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('runs the legacy baseline against existing legacy DBs so rebased legacy changes apply', async () => {
    const db = new Database(':memory:');

    try {
      runLegacyBaseline(db);
      db.prepare(`
        UPDATE models
           SET enabled = 1
         WHERE platform = 'opencode'
           AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
      `).run();

      expect(getEnabledZenDeadPromoCount(db)).toBe(2);

      await runMigrations(db, 'up');

      expect(getEnabledZenDeadPromoCount(db)).toBe(0);
      expect(getAppliedMigrationNames(db)).toEqual([
        LEGACY_BASELINE_FILENAME,
        CUSTOM_PROVIDER_MODALITIES_FILENAME,
        CATALOG_MODEL_STATE_FILENAME,
        REQUEST_AGGREGATES_FILENAME,
        GITHUB_GPT41_CONTEXT_FILENAME,
        REQUEST_CLIENT_INFO_FILENAME,
        CUSTOM_MODEL_TOOL_SUPPORT_FILENAME,
        PROFILE_CHAIN_BACKFILL_FILENAME,
        KEY_HEALTH_ERROR_FILENAME,
        COOLDOWN_PROBE_PROVENANCE_FILENAME,
        REQUEST_ATTEMPTS_FILENAME,
        MODEL_SOURCE_PROVENANCE_FILENAME,
        MEDIA_MODEL_META_FILENAME,
        REQUEST_SERVED_MODEL_FILENAME,
        ATTEMPT_ERROR_SUMMARY_FILENAME,
        AGENT_COMPATIBILITY_FILENAME,
        TOMBSTONE_PROVENANCE_FILENAME,
        CUSTOM_MODEL_ENDPOINT_IDENTITY_FILENAME,
        CUSTOM_ENDPOINT_HOST_LABELS_FILENAME,
        KEY_MODEL_SCOPE_FILENAME,
        CLIENT_PROFILES_FILENAME,
        API_KEY_PROXY_FILENAME,
        CUSTOM_MODEL_TOMBSTONES_FILENAME,
        PLAYGROUND_CONVERSATIONS_FILENAME,
        SERVER_LOGS_FILENAME,
        BACKUPS_TABLE_FILENAME,
        ATTEMPT_KEY_LABEL_FILENAME,
        PROFILE_AUTO_INCLUDE_FILENAME,
        IDEMPOTENCY_CLAIMS_FILENAME,
        QUOTA_OBSERVATION_LOOKUP_FILENAME,
      ]);
    } finally {
      db.close();
    }
  });

  it('runs all migrations up, down to baseline, then up to the same schema', async () => {
    const db = new Database(':memory:');

    try {
      await runMigrations(db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);

      // The catalog seed has no custom models, so the custom-model tool-support
      // backfill only alters state once a user endpoint exists. Seed one (in its
      // post-migration state, tools = 1) so the round trip actually exercises
      // that migration's down (tools -> 0) and up (tools -> 1).
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, enabled, source)
        VALUES ('custom', 'roundtrip-custom', 'Roundtrip Custom', 50, 50, 1, 0, 1, 'user')
      `).run();

      // Same reasoning for the endpoint-label rename (#704): it only touches
      // custom api_keys rows, so seed one in its post-migration state (labelled
      // with its host) for the down (host -> 'Custom') and up to exercise.
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url)
        VALUES ('custom', '127.0.0.1:11434', 'x', 'x', 'x', 'http://127.0.0.1:11434/v1')
      `).run();

      const fullState = snapshotAppState(db);
      await runDownToBaseline(db);

      expect(getAppliedMigrationNames(db)).toEqual([LEGACY_BASELINE_FILENAME]);

      await runMigrations(db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);
      expect(snapshotAppState(db)).toEqual(fullState);
    } finally {
      db.close();
    }
  });
});

async function runDownToBaseline(db: Database.Database): Promise<void> {
  while (getAppliedMigrationNames(db).length > 1) {
    const migrationName = getLatestAppliedMigrationName(db);
    const before = snapshotAppState(db);

    await runMigrations(db, 'down');

    expect(snapshotAppState(db), `${migrationName} down() must alter app DB state or throw irreversible`)
      .not.toEqual(before);
  }
}

function getLatestAppliedMigrationName(db: Database.Database): string {
  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) throw new Error('No applied migrations found');
  return row.filename;
}

function getAppliedMigrationNames(db: Database.Database): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'applied')
    .map(status => status.filename);
}

function getPendingMigrationNames(db: Database.Database): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'pending')
    .map(status => status.filename);
}

function getEnabledZenDeadPromoCount(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM models
     WHERE platform = 'opencode'
       AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
       AND enabled = 1
  `).get() as { count: number };

  return row.count;
}

function snapshotSchema(db: Database.Database): SchemaRow[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE type IN ('index', 'table', 'trigger', 'view')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name
  `).all() as SchemaRow[];
}

function snapshotAppState(db: Database.Database): DatabaseSnapshot {
  const tableNames = getAppTableNames(db);
  const rows: Record<string, unknown[]> = {};

  for (const tableName of tableNames) {
    rows[tableName] = snapshotTableRows(db, tableName);
  }

  return {
    schema: snapshotSchema(db),
    rows,
  };
}

function getAppTableNames(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name <> 'migrations'
     ORDER BY name
  `).all() as { name: string }[];

  return rows.map(row => row.name);
}

function snapshotTableRows(db: Database.Database, tableName: string): unknown[] {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as { name: string }[];
  const orderBy = columns.map(column => quoteIdentifier(column.name)).join(', ');

  return db.prepare(`
    SELECT *
      FROM ${quoteIdentifier(tableName)}
     ORDER BY ${orderBy}
  `).all() as unknown[];
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
  `).get(tableName);

  return Boolean(row);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
