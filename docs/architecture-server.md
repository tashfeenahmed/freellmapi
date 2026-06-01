# FreeLLMAPI — Architecture (Server)

**Generated:** 2026-05-31 | **Part:** server

## Executive Summary

The server is a stateful Express 5 API gateway that multiplexes incoming OpenAI-compatible chat completion requests across 17 free-tier LLM providers. It manages encrypted key storage, intelligent routing with dynamic penalty-based failover, sliding-window rate limiting with SQLite persistence, and Hermes-compatible session storage with FTS5 full-text search.

## Technology Stack

| Category | Technology | Version |
|----------|-----------|---------|
| Runtime | Node.js | 22+ |
| Language | TypeScript | 5.8 |
| Framework | Express | 5.1 |
| Database | better-sqlite3 (WAL + FTS5) | 12.4 |
| Validation | Zod | 3.24 |
| Security | helmet | 8.1 |
| CORS | cors | 2.8 |
| Testing | Vitest | 3.1 |

## Architecture Pattern

**Middleware Pipeline** — requests flow through Express middleware in sequence:

```
Request → helmet → cors → json parse → route handler → error handler
                                            │
                                     ┌──────▼──────┐
                                     │ Service Layer │
                                     ├──────────────┤
                                     │ router.ts     │ → Fallback chain + key selection
                                     │ ratelimit.ts  │ → Sliding window RPM/TPM
                                     │ memory.ts     │ → Session storage + FTS5
                                     │ health.ts     │ → Periodic key validation
                                     └──────┬───────┘
                                            │
                                     ┌──────▼──────┐
                                     │ Provider     │
                                     │ Adapters     │ → 17 upstream API calls
                                     └──────┬───────┘
                                            │
                                     ┌──────▼──────┐
                                     │ SQLite       │
                                     │ WAL + FTS5   │ → Persistent state
                                     └─────────────┘
```

## Core Components

### Request Routing (`services/router.ts`)

The `routeRequest()` function implements a priority-based fallback chain:

1. Load `fallback_config` ordered by priority
2. Apply **dynamic 429 penalties** (3 points per 429, decay over 2 minutes)
3. **Sticky session override** — if `preferredModelDbId` is set, move it to front
4. For each model in chain: check enabled keys → check cooldown → check rate limits → decrypt key → return first viable route
5. **Round-robin** key selection within each model to distribute load

### Rate Limiting (`services/ratelimit.ts`)

Dual-layer tracking:

- **In-memory sliding window** — `Map<key, Window>` for sub-millisecond checks
- **SQLite persistence** — `rate_limit_usage` table for crash recovery
- **Escalating cooldowns** — 429s trigger progressively longer cooldowns: 2min → 10min → 1hr → 24hr

### Hermes Session Storage (`services/memory.ts`)

Full Hermes-parity session management:

- **Session CRUD** — create, get, update, end, reopen, delete
- **Title management** — auto-incrementing `#N` suffix for duplicates
- **Lineage traversal** — recursive CTEs for ancestor/descendant chains
- **FTS5 search** — `snippet()` with `>>>match<<<` highlighting, role/source filtering
- **Pruning** — `pruneOldSessions()` with cascading FK cleanup
- **Export** — full session export with messages

### Provider Adapters (`providers/`)

- **`BaseProvider`** — abstract class with `chat()`, `chatStream()`, `validateKey()`
- **`OpenAICompatProvider`** — generic adapter for 13 OpenAI-compatible providers
- **Custom adapters** — `GoogleProvider` (Gemini API), `CohereProvider`, `CloudflareProvider`, `MemosProvider`

### Key Encryption (`lib/crypto.ts`)

- **Algorithm:** AES-256-GCM
- **Key derivation:** `ENCRYPTION_KEY` env var (64-char hex → 32-byte key)
- **Operations:** `encrypt(plaintext)` → `{encrypted, iv, authTag}`, `decrypt(encrypted, iv, authTag)` → plaintext

## Data Architecture

Single SQLite database in WAL mode with 10 tables:

- **Core:** `models`, `api_keys`, `fallback_config`, `settings`
- **Analytics:** `requests`
- **Rate limiting:** `rate_limit_usage`, `rate_limit_cooldowns`
- **Hermes memory:** `sessions`, `messages`, `messages_fts` (FTS5)

See [Data Models](./data-models-server.md) for complete schema.

## Write Contention Protocol

```
PRAGMA busy_timeout = 1000;   // 1-second SQLite timeout
runWithRetry(fn, maxRetries=15, jitter=20-150ms)
recordWriteAndMaybeCheckpoint()  // PASSIVE checkpoint every 50 writes
```

## Deployment Architecture

- **Entry:** `node dist/index.js` (compiled TypeScript)
- **Static serving:** Express serves `client/dist/` with SPA fallback
- **Port:** configurable via `PORT` env var (default 3001)
- **Database:** `server/data/freellmapi.db` (created on first run)

## Testing Strategy

| Category | Files | Tests | Coverage Focus |
|----------|-------|-------|---------------|
| Routes | 7 | ~60 | Proxy retry, auth, CORS, tools, content |
| Services | 4 | ~40 | Router exhaustion, rate limits, memory |
| Providers | 4 | ~25 | Google schema, Cloudflare, Cohere, generic |
| Lib | 3 | ~15 | Crypto, content normalization |
| DB | 1 | ~5 | Migration idempotency |
| Integration | 1 | ~9 | Full request flow |
