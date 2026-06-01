# FreeLLMAPI — Data Models

**Generated:** 2026-05-31 | **Part:** server

## Database Engine

- **SQLite** via `better-sqlite3` v12.4 in **WAL mode**
- **Location:** `server/data/freellmapi.db`
- **Schema:** 16 migration versions (V1–V16) in `server/src/db/index.ts`
- **Write contention:** Hermes protocol (1s timeout, `runWithRetry` with jitter, periodic WAL checkpoints)

## Tables

### `models`

Model catalog — all supported LLM models across platforms.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| platform | TEXT NOT NULL | Provider identifier |
| model_id | TEXT NOT NULL | Upstream model identifier |
| display_name | TEXT | Human-readable name |
| intelligence_rank | INTEGER | Quality ranking (lower = smarter) |
| speed_rank | INTEGER | Speed ranking (lower = faster) |
| size_label | TEXT | e.g. "small", "medium", "large" |
| rpm_limit | INTEGER | Requests per minute (null = unlimited) |
| rpd_limit | INTEGER | Requests per day |
| tpm_limit | INTEGER | Tokens per minute |
| tpd_limit | INTEGER | Tokens per day |
| monthly_token_budget | TEXT | Human-readable budget string |
| context_window | INTEGER | Max context tokens |
| enabled | INTEGER | 1 = active, 0 = disabled |

**Unique constraint:** `(platform, model_id)`

### `api_keys`

Encrypted API key storage.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| platform | TEXT NOT NULL | Provider identifier |
| label | TEXT | User-assigned label |
| encrypted_key | TEXT NOT NULL | AES-256-GCM ciphertext |
| iv | TEXT NOT NULL | Initialization vector (hex) |
| auth_tag | TEXT NOT NULL | GCM auth tag (hex) |
| status | TEXT | 'healthy' / 'rate_limited' / 'invalid' / 'error' / 'unknown' |
| enabled | INTEGER | 1 = active |
| created_at | TEXT | ISO datetime |
| last_checked_at | TEXT | ISO datetime (health check) |

### `requests`

Request log for analytics.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| platform | TEXT | Provider used |
| model_id | TEXT | Model used |
| status | TEXT | 'success' / 'error' |
| input_tokens | INTEGER | Prompt tokens |
| output_tokens | INTEGER | Completion tokens |
| latency_ms | INTEGER | Request duration |
| error | TEXT | Error message (null on success) |
| created_at | TEXT | ISO datetime |
| key_id | INTEGER | API key used |

### `fallback_config`

Ordered fallback chain for model routing.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| model_db_id | INTEGER UNIQUE | FK → models(id) |
| priority | INTEGER | Lower = tried first |
| enabled | INTEGER | 1 = active in chain |

### `sessions` (V16 — Hermes Session Storage)

Session metadata with lineage support.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| source | TEXT NOT NULL | Client identifier (e.g. "web-client", "cli") |
| user_id | TEXT | Optional user identifier |
| model | TEXT | Model used |
| system_prompt | TEXT | System message |
| parent_session_id | TEXT FK | → sessions(id) ON DELETE SET NULL |
| title | TEXT | Session title (unique when non-null) |
| ended_at | TEXT | ISO datetime when ended |
| end_reason | TEXT | e.g. "user_exit", "timeout" |
| prompt_tokens | INTEGER | Cumulative prompt tokens |
| completion_tokens | INTEGER | Cumulative completion tokens |
| total_tokens | INTEGER | Cumulative total tokens |
| cost | REAL | Cumulative cost |
| created_at | TEXT | ISO datetime |
| updated_at | TEXT | Auto-updated via triggers |

**Indexes:** `idx_sessions_source`, `idx_sessions_parent`, `idx_sessions_created`, `idx_sessions_title_unique`

### `messages` (V16 — Hermes Session Storage)

Full message history per session.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| session_id | TEXT NOT NULL FK | → sessions(id) ON DELETE CASCADE |
| role | TEXT NOT NULL | 'system' / 'user' / 'assistant' / 'tool' |
| content | TEXT NOT NULL | Message content |
| tool_calls | TEXT | JSON array of tool calls |
| reasoning | TEXT | Model reasoning output |
| reasoning_content | TEXT | Extended reasoning content |
| timestamp | REAL | High-precision Unix timestamp |
| created_at | TEXT | ISO datetime |

**Index:** `idx_messages_session` on `(session_id, timestamp)`

### `messages_fts` (FTS5 Virtual Table)

Full-text search index for messages.

| Column | Type | Notes |
|--------|------|-------|
| message_id | TEXT UNINDEXED | Link to messages(id) |
| session_id | TEXT UNINDEXED | Link to sessions(id) |
| role | TEXT | Indexed for role filtering |
| content | TEXT | Indexed for full-text search |

**Sync triggers:** `messages_fts_insert`, `messages_fts_delete`, `messages_fts_update`

### `rate_limit_usage`

Sliding window rate limit tracking.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| platform | TEXT | Provider |
| model_id | TEXT | Model |
| key_id | INTEGER | API key |
| kind | TEXT | 'request' / 'tokens' |
| tokens | INTEGER | Token count (0 for requests) |
| created_at_ms | INTEGER | Epoch milliseconds |

### `rate_limit_cooldowns`

Persisted cooldown state for rate-limited keys.

| Column | Type | Notes |
|--------|------|-------|
| platform | TEXT | |
| model_id | TEXT | |
| key_id | INTEGER | |
| expires_at_ms | INTEGER | Epoch milliseconds |

**Unique constraint:** `(platform, model_id, key_id)`

### `settings`

Key-value settings store.

| Column | Type | Notes |
|--------|------|-------|
| key | TEXT PK | Setting name |
| value | TEXT | Setting value |

Known keys: `unified_api_key`, `encryption_key_hash`

## Entity Relationship Diagram

```
models 1──N fallback_config
models 1──N requests
api_keys 1──N requests

sessions 1──N messages
sessions 1──1 sessions (parent_session_id → id)
messages 1──1 messages_fts (trigger-synced)
```

## Migration Strategy

All migrations are **idempotent** TypeScript functions (`migrateModelsV1` through `migrateModelsV16`) executed sequentially at database initialization. Each uses `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and PRAGMA-based column existence checks for `ALTER TABLE` safety.
