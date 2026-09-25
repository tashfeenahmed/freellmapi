import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    -- 1. Providers table
    CREATE TABLE IF NOT EXISTS providers (
      id SERIAL PRIMARY KEY,
      provider_key VARCHAR(64) UNIQUE NOT NULL,
      display_name VARCHAR(128) NOT NULL,
      base_url TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_providers_key ON providers(provider_key);
    CREATE INDEX IF NOT EXISTS idx_providers_enabled ON providers(enabled);

    -- 2. Credentials table (Encrypted at rest)
    CREATE TABLE IF NOT EXISTS credentials (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      credential_name VARCHAR(128) NOT NULL DEFAULT '',
      encrypted_value TEXT NOT NULL,
      iv VARCHAR(64) NOT NULL,
      auth_tag VARCHAR(64) NOT NULL,
      credential_type VARCHAR(32) NOT NULL DEFAULT 'api_key',
      enabled BOOLEAN NOT NULL DEFAULT true,
      priority INTEGER NOT NULL DEFAULT 0,
      cooldown_until TIMESTAMPTZ,
      success_count BIGINT NOT NULL DEFAULT 0,
      failure_count BIGINT NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      last_failed_at TIMESTAMPTZ,
      model_scope JSONB DEFAULT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_credentials_provider ON credentials(provider_id);
    CREATE INDEX IF NOT EXISTS idx_credentials_enabled ON credentials(enabled);
    CREATE INDEX IF NOT EXISTS idx_credentials_cooldown ON credentials(cooldown_until);

    -- 3. Models table
    CREATE TABLE IF NOT EXISTS models (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      model_id VARCHAR(128) NOT NULL,
      canonical_name VARCHAR(128) NOT NULL,
      display_name VARCHAR(128) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      context_window INTEGER,
      max_output_tokens INTEGER,
      supports_streaming BOOLEAN NOT NULL DEFAULT true,
      supports_tools BOOLEAN NOT NULL DEFAULT false,
      supports_vision BOOLEAN NOT NULL DEFAULT false,
      supports_structured_output BOOLEAN NOT NULL DEFAULT false,
      supports_reasoning BOOLEAN NOT NULL DEFAULT false,
      input_price NUMERIC(10, 6) DEFAULT 0,
      output_price NUMERIC(10, 6) DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      intelligence_rank INTEGER NOT NULL DEFAULT 0,
      speed_rank INTEGER NOT NULL DEFAULT 0,
      size_label VARCHAR(64) NOT NULL DEFAULT '',
      rpm_limit INTEGER DEFAULT NULL,
      rpd_limit INTEGER DEFAULT NULL,
      tpm_limit INTEGER DEFAULT NULL,
      tpd_limit INTEGER DEFAULT NULL,
      monthly_token_budget VARCHAR(128) NOT NULL DEFAULT '',
      key_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
      endpoint_scope TEXT DEFAULT NULL,
      paid_input_per_m NUMERIC(10, 6) DEFAULT NULL,
      paid_output_per_m NUMERIC(10, 6) DEFAULT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_provider_model UNIQUE (provider_id, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
    CREATE INDEX IF NOT EXISTS idx_models_canonical ON models(canonical_name);
    CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled);

    -- 4. Routing configuration table
    CREATE TABLE IF NOT EXISTS routing_configuration (
      id SERIAL PRIMARY KEY,
      config_key VARCHAR(64) UNIQUE NOT NULL,
      config_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 5. Analytics Hourly table (Aggregated Telemetry)
    CREATE TABLE IF NOT EXISTS analytics_hourly (
      id SERIAL PRIMARY KEY,
      bucket_start TIMESTAMPTZ NOT NULL,
      provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
      model_id VARCHAR(128) NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      total_tokens BIGINT NOT NULL DEFAULT 0,
      latency_sum_ms BIGINT NOT NULL DEFAULT 0,
      latency_count INTEGER NOT NULL DEFAULT 0,
      rate_limit_count INTEGER NOT NULL DEFAULT 0,
      timeout_count INTEGER NOT NULL DEFAULT 0,
      fallback_count INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT uq_analytics_hourly_bucket UNIQUE (bucket_start, provider_id, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_bucket_start ON analytics_hourly(bucket_start);
    CREATE INDEX IF NOT EXISTS idx_analytics_provider_bucket ON analytics_hourly(provider_id, bucket_start);
    CREATE INDEX IF NOT EXISTS idx_analytics_model_bucket ON analytics_hourly(model_id, bucket_start);

    -- 6. Settings table
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(128) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 7. Client profiles table
    CREATE TABLE IF NOT EXISTS client_profiles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      api_key VARCHAR(128) UNIQUE NOT NULL,
      system_prompt TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 8. Users table for admin dashboard
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 9. Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash VARCHAR(128) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at_ms BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- 10. Playground conversations table
    CREATE TABLE IF NOT EXISTS playground_conversations (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL DEFAULT 'New Conversation',
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      model_id VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 11. Media models table
    CREATE TABLE IF NOT EXISTS media_models (
      id SERIAL PRIMARY KEY,
      platform VARCHAR(64) NOT NULL,
      model_id VARCHAR(128) NOT NULL,
      display_name VARCHAR(128) NOT NULL,
      modality VARCHAR(32) NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      quota_label VARCHAR(128) DEFAULT '',
      key_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
      meta_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS media_models CASCADE;
    DROP TABLE IF EXISTS playground_conversations CASCADE;
    DROP TABLE IF EXISTS sessions CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS client_profiles CASCADE;
    DROP TABLE IF EXISTS settings CASCADE;
    DROP TABLE IF EXISTS analytics_hourly CASCADE;
    DROP TABLE IF EXISTS routing_configuration CASCADE;
    DROP TABLE IF EXISTS models CASCADE;
    DROP TABLE IF EXISTS credentials CASCADE;
    DROP TABLE IF EXISTS providers CASCADE;
  `);
}
