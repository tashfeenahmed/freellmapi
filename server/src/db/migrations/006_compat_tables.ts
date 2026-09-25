import pg from 'pg';

// The tables the SQLite→PostgreSQL migration (88b1cfcd) left behind.
//
// 001..005 created the fork's core schema (providers, credentials, models,
// settings, users, sessions, media_models, client_profiles, analytics_hourly,
// routing_configuration, playground_conversations) and 88b1cfcd rewired the
// ROUTER onto it — but the rest of the server (profile chains, fallback order,
// the embedding catalog, quirks, quota observations, response cache,
// idempotency claims, server logs, backups, URL tokens, model tombstones) still
// reads and writes the SQLite-era tables that never got a PostgreSQL
// equivalent. Against the real pool those `db.prepare()` calls hit the no-op
// shim in db/postgres.ts, so the features silently did nothing while the suite
// went red (837 failing tests before the upstream merge).
//
// This migration gives those code paths real tables. The column shapes are
// translated 1:1 from upstream's SQLite DDL (server/src/db/migrations/*.ts on
// the upstream branch) so the ported call sites and their tests can keep the
// statements they already have:
//   INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
//   TEXT timestamps / datetime('now')  → TIMESTAMPTZ ... DEFAULT NOW()
//   INTEGER 0/1 booleans               → kept as INTEGER (the code compares
//                                        against 0/1, and so do the tests)

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    -- Named model fallback profiles (dashboard chains).
    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#6366f1',
      type TEXT NOT NULL DEFAULT 'custom',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      auto_sort TEXT,
      layout_config TEXT,
      auto_include_new_models INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One row per model in a chain; priority is the order, enabled the toggle.
    CREATE TABLE IF NOT EXISTS profile_models (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(profile_id, model_db_id)
    );
    CREATE INDEX IF NOT EXISTS idx_profile_models_profile ON profile_models(profile_id, priority);

    -- Cross-model fallback order: which model to try when one is down.
    CREATE TABLE IF NOT EXISTS fallback_config (
      id SERIAL PRIMARY KEY,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fallback_config_priority ON fallback_config(priority);

    -- The embedding catalog is its own table: embeddings resolve by family
    -- ('voyage') or provider model id, never through the chat models table.
    CREATE TABLE IF NOT EXISTS embedding_models (
      id SERIAL PRIMARY KEY,
      family TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      max_input_tokens INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      quota_label TEXT NOT NULL DEFAULT '',
      UNIQUE(platform, model_id)
    );

    -- Custom model tombstones: an operator-deleted model must not come back on
    -- the next catalog sync, so the deletion is recorded by (endpoint, model).
    CREATE TABLE IF NOT EXISTS custom_model_tombstones (
      endpoint_scope TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (endpoint_scope, model_id)
    );

    -- Provider-specific request quirks the dashboard can show and toggle.
    CREATE TABLE IF NOT EXISTS quirks (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'info',
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quirk_targets (
      id SERIAL PRIMARY KEY,
      quirk_id INTEGER NOT NULL REFERENCES quirks(id) ON DELETE CASCADE,
      platform TEXT,
      model_glob TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quirk_targets_quirk ON quirk_targets(quirk_id);

    -- Quota limits learned from provider responses (headers), kept per key so
    -- one account's plan cannot be attributed to its siblings.
    CREATE TABLE IF NOT EXISTS provider_quota_observations (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      provider_account_id TEXT,
      model_id TEXT,
      quota_pool_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      status_code INTEGER,
      limit_value INTEGER,
      remaining_value INTEGER,
      reset_at TEXT,
      retry_after_ms INTEGER,
      reset_strategy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'probe',
      confidence REAL NOT NULL DEFAULT 0,
      notes TEXT,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_latest
      ON provider_quota_observations(platform, key_id, quota_pool_key, metric, observed_at DESC);

    -- The denormalised "latest known state" the routing hot path reads.
    CREATE TABLE IF NOT EXISTS provider_quota_state (
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      quota_pool_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      limit_value INTEGER,
      remaining_value INTEGER,
      reset_at TEXT,
      reset_strategy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'probe',
      confidence REAL NOT NULL DEFAULT 0,
      notes TEXT,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (platform, key_id, quota_pool_key, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_quota_state_platform
      ON provider_quota_state(platform, key_id, updated_at);

    -- Response cache: bodies keyed by the request fingerprint, with a hit count
    -- flushed in batches and an expiry the reader checks.
    CREATE TABLE IF NOT EXISTS response_cache (
      cache_key TEXT PRIMARY KEY,
      body_json TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at_ms BIGINT NOT NULL,
      last_hit_at_ms BIGINT,
      expires_at_ms BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_response_cache_expiry ON response_cache(expires_at_ms);

    -- Idempotency-Key claims: the first caller wins, replays get the stored
    -- response instead of being executed twice.
    CREATE TABLE IF NOT EXISTS idempotency_claims (
      id SERIAL PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      execution_id TEXT,
      created_at_ms BIGINT NOT NULL,
      expires_at_ms BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_claims_expiry ON idempotency_claims(expires_at_ms);

    -- Server-side warn/error log surfaced in the dashboard's Logs tab.
    CREATE TABLE IF NOT EXISTS server_logs (
      id SERIAL PRIMARY KEY,
      level TEXT,
      source TEXT,
      provider TEXT,
      model TEXT,
      event TEXT,
      request_id TEXT,
      message TEXT NOT NULL,
      created_at_ms BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_server_logs_created ON server_logs(created_at_ms DESC);

    -- Backup bookkeeping: what was written where, and which tables it covers.
    CREATE TABLE IF NOT EXISTS backups (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      filepath TEXT,
      filesize INTEGER NOT NULL,
      is_full INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tables_json TEXT NOT NULL DEFAULT '[]'
    );

    -- URL tokens authenticate direct /v1 calls (Ollama-compatible surface).
    CREATE TABLE IF NOT EXISTS url_tokens (
      id SERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      token_prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_url_tokens_active ON url_tokens(token_hash, revoked_at);
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS url_tokens;
    DROP TABLE IF EXISTS backups;
    DROP TABLE IF EXISTS server_logs;
    DROP TABLE IF EXISTS idempotency_claims;
    DROP TABLE IF EXISTS response_cache;
    DROP TABLE IF EXISTS provider_quota_state;
    DROP TABLE IF EXISTS provider_quota_observations;
    DROP TABLE IF EXISTS quirk_targets;
    DROP TABLE IF EXISTS quirks;
    DROP TABLE IF EXISTS custom_model_tombstones;
    DROP TABLE IF EXISTS embedding_models;
    DROP TABLE IF EXISTS fallback_config;
    DROP TABLE IF EXISTS profile_models;
    DROP TABLE IF EXISTS profiles;
  `);
}
