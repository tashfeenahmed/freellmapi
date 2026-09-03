# Observability — Deep Dive

> **Source:** `server/src/lib/server-logs.ts`, `server/src/routes/logs.ts`, `server/src/lib/request-log.ts`, `server/src/lib/log-redaction.ts`, `server/src/lib/attempt-trace.ts`

## 1. Server Logs Viewer (`server-logs.ts`)

> **User-facing guide:** the dashboard viewer, its two-tier store, the polling API (`/api/logs`, `/api/logs/counts`, `/api/logs/clear`), environment variables, and the React client implementation are documented in **[`logs/01-server-logs-viewer.md`](../logs/01-server-logs-viewer.md)**. This section covers the internals that guide deliberately omits.

The store keeps a 1000-entry in-memory ring (all levels) plus a persisted `server_logs` SQLite table (warn/error only) behind a single `sinceId`-based id space. For the operator-facing contract (tier capacities, retention, cursor semantics, request/response shape) see the [Server Logs Viewer guide](../logs/01-server-logs-viewer.md#two-tier-store) and its [API contract](../logs/01-server-logs-viewer.md#api-contract).

### Ingest Path

```
console.log/warn/error/debug/trace
    │
    ▼
lib/log-redaction.ts (console wrapper)
    ├─ redacts secrets (API keys, tokens, auth headers, etc.)
    ▼
server-logs.ts.recordConsoleLine(level, args)
    ├─ formats args (Error → stack, objects → inspect depth 2)
    ├─ noise filter + length cap
    ├─ pushes to ring (splice if > 1000)
    └─ if level ∈ {warn, error} → persist(entry) → INSERT INTO server_logs
```

**Reentrancy guards**:
- `mirroring` — `providerLog()` mirrors to stdout via wrapped console; prevents double-ingest.
- `persisting` — DB layer can log (busy timeout, permissions); skips persist write but ring still accepts.
- `seeding` — boot seed probes DB, which can log.

### Structured Provider Logs

```typescript
providerLog(level, message, { provider, model, event, requestId })
```

- Recorded with metadata for dashboard filtering **AND** mirrored to stdout (redacted).
- Used by: Health checker, Cooldown probe, Router, Fallback loop, Catalog sync.

### Boot Preload

On first ingest (or explicit `initServerLogs()` call):
1. Seed `lastId` from `MAX(id)` in `server_logs`.
2. Preload latest 200 persisted rows (newest-first, reversed to oldest-first in ring).
3. Re-stamp any pre-DB ring entries **above** persisted max (IDs unique across tiers).

### Querying & Maintenance

The public query API (`queryLogs({ levels, q, provider, sinceId, limit })`), level-count badges (`levelCounts()`), and clear/reset behavior (`clearLogs()`, `resetServerLogsForTest()`) are specified in the [Server Logs Viewer API contract](../logs/01-server-logs-viewer.md#api-contract). The ID counter is preserved across `clearLogs()` so a dashboard cursor never sees duplicate ids.

### Desktop file logger

The desktop app has no terminal attached, so it tees every console line to a **file logger** (`desktop/src/logger.ts`, added in `90aaa5b`) instead of relying on the in-memory ring: `<data dir>/logs/freeapi.log`, plus one rotated `freeapi.log.1` at 1 MB each. The same redaction wrapper feeds both the ring (server) and the file (desktop), so secrets never reach the file either. The desktop's password-reset code appears here — see the [Install & deploy FAQ](../install.md#where-are-the-logs).

---

## 2. Request Analytics (`request-log.ts`)

### Per-Request Row (`requests` table)

| Column | Source |
|--------|--------|
| `platform`, `model_id`, `key_id` | RouteResult |
| `request_type` | `'chat' \| 'embeddings' \| 'image' \| 'speech' \| 'transcription' \| 'fusion'` |
| `status` | `'success' \| 'error' \| 'canceled'` |
| `input_tokens`, `output_tokens`, `total_tokens` | Provider usage + estimates |
| `latency_ms` | Wall-clock |
| `ttfb_ms` | First token (content OR reasoning) |
| `error` | Redacted provider message |
| `created_at_ms` | Timestamp |
| `client_info` | User agent, IP hash |
| `served_model` | Upstream-reported model (observability) |
| `attempt_error_summary` | Aggregated failure classes for this request |

### Attempt Trail (`request_attempts` table)

One row per dispatched-and-failed attempt:

| Column | Purpose |
|--------|---------|
| `request_id` | FK to `requests` |
| `attempt_ordinal` | 0-based |
| `platform`, `model_id`, `key_id` | What was tried |
| `error_class` | `AttemptErrorClass` (auth, rate_limited, upstream_error, ...) |
| `error_summary` | Redacted provider message (≤200 chars) |
| `latency_ms` | Per-attempt wall-clock |
| `ttfb_ms` | Per-attempt TTFB |
| `input_tokens`, `output_tokens` | Per-attempt estimates |

- Powers `X-Fallback-Trail` / `X-Fallback-Detail` headers.
- Enables per-request drill-down in dashboard.

### Aggregates (`request_aggregates` materialized view)

Pre-computed rollups for dashboard charts (24h / 7d / 30d / 90d windows):
- Latency p50 / p95 / p99
- TTFB p50 / p95
- Token throughput
- Success rate
- Estimated cost savings
- Per-provider / per-model / per-key breakdowns

---

## 3. Log Redaction (`log-redaction.ts`)

### What Gets Redacted

| Pattern | Replacement |
|---------|-------------|
| `Bearer <token>` | `Bearer [REDACTED]` |
| `x-api-key: <key>` | `x-api-key: [REDACTED]` |
| `x-goog-api-key: <key>` | `x-goog-api-key: [REDACTED]` |
| `Authorization: Basic <creds>` | `Authorization: Basic [REDACTED]` |
| API keys in JSON bodies | `[REDACTED]` |
| URLs with embedded credentials | `[REDACTED]` |
| SQLite encryption keys | `[REDACTED]` |

- Single pass at console wrapper → **all** log paths (console, providerLog, boot lines) are redacted.
- Idempotent: already-redacted text passes through unchanged.

---

## 4. Attempt Tracing (`attempt-trace.ts`)

### AsyncLocalStorage Scope

Each request gets an `AsyncLocalStorage<RequestTrace>` scope:

```typescript
interface RequestTrace {
  requestId: string;
  startedAtMs: number;
  records: AttemptTraceRecord[];
}

interface AttemptTraceRecord {
  platform: string;
  modelId: string;
  keyOrdinal: number;      // 1-based per request
  outcome: AttemptOutcome; // 'success' | 'retryable_failure' | 'auth_failure' | 'fatal' | 'hedge_abort'
  startOffsetMs: number;   // relative to request start
  durationMs: number;
  errorSummary: string | null; // redacted, ≤200 chars
}
```

- `runWithRequestTrace(fn)` wraps the fallback loop.
- `dispatch()` records start offset, runs attempt, records duration + outcome + summary.
- `getRequestTrace()` reads current scope (for `X-Fallback-Detail` header).

### Outcomes

| Outcome | Meaning |
|---------|---------|
| `success` | Attempt completed, response sent |
| `retryable_failure` | 429/5xx/timeout/empty → failover |
| `auth_failure` | 401 → key revalidation triggered |
| `fatal` | Non-retryable (400, 404 model gone, etc.) |
| `hedge_abort` | Budget expired mid-attempt (1d2226a) |

---

## 5. Health Endpoint (`/api/health`, `/livez`, `/readyz`)

| Endpoint | Purpose |
|----------|---------|
| `GET /livez` | Process alive (k8s liveness) |
| `GET /readyz` | Ready to serve (DB + at least one healthy provider) |
| `GET /api/health` | Full status: `{status, degraded, providers: [{platform, healthy, totalKeys, usableKeys, status}], catalog: {version, tier, lastSync}}` |

- Degraded mode reported via `degradation.getDegradationStatus()`.
- Provider health from `api_keys` statuses (healthy/unknown/rate_limited/invalid/error).

---

## 6. Routing Trace Headers (Every Response)

| Header | Value |
|--------|-------|
| `X-Request-ID` | UUID (or client `x-request-id`) |
| `X-Routed-Via` | `platform/model` (safeHeaderValue) |
| `X-Fallback-Attempts` | Failed hops before success/exhaustion |
| `X-Fallback-Trail` | `platform/model keyN=class; …` (max 10, 1KB) |
| `X-Fallback-Detail` | **Opt-in**: `platform/model keyN=outcome t=start+dur msg=summary; …` (2KB) |
| `Retry-After` | Seconds until soonest cooldown expiry (429 exhaustions) |
| `X-FreeLLM-Cache` | `HIT` / `MISS` (response cache) |
| `X-FreeLLM-Compress` | Compression pipeline metadata |

---

## 7. Dashboard Analytics Pages

| Page | Data Source |
|------|-------------|
| **Overview** | `request_aggregates` (24h/7d/30d/90d) |
| **Models** | Per-model latency, tokens, success rate, cost savings |
| **Providers** | Per-provider breakdown + quota usage |
| **Keys** | Per-key health, usage, cooldowns, revalidation history |
| **Logs** | `server_logs` ring + persisted (filter by level, provider, search) |
| **Cache** | Hit rate, token savings, LRU stats |

---

## 8. Key Functions (server-logs.ts)

| Function | Purpose |
|----------|---------|
| `recordLogEntry(options)` | Single ingest point (console tap, providerLog, boot preload) |
| `recordConsoleLine(level, args)` | Called by log-redaction wrapper |
| `providerLog(level, message, meta)` | Structured + stdout mirror |
| `initServerLogs()` | Force seed/preload (route calls on first poll) |
| `queryLogs(query)` | Filtered, paginated, cursor-based |
| `levelCounts()` | Dashboard badges |
| `currentMaxId()` | Cursor ceiling |
| `clearLogs()` | Empty both tiers (ID counter preserved) |
| `resetServerLogsForTest()` | Test cold-start simulation |

---

## 9. Key Functions (request-log.ts)

| Function | Purpose |
|----------|---------|
| `logRequest(platform, modelId, keyId, status, inTokens, outTokens, latencyMs, error, ttfbMs, pinnedModelId)` | Insert request row |
| `persistRequestAttempts(requestId, attempts)` | Batch insert attempt trail |
| `getRequestAnalytics(window)` | Aggregated rollups for dashboard |
| `getRequestAttempts(requestId)` | Per-request drill-down |

---

## 10. Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `RESPONSE_CACHE` | `0` | Enable response cache (opt-in) |
| `REQUEST_MAX_TOKENS_BUDGET` | `0` (off) | Per-request token ceiling |
| `FALLBACK_TIME_BUDGET_MS` | `45000` | Retry budget (affects exhaustion) |
| `MAX_CONSECUTIVE_UPSTREAM_FAILS` | `0` (off) | Circuit breaker threshold |
| `EXPOSE_FALLBACK_DETAIL_HEADER` | `0` | Opt-in X-Fallback-Detail |
| `COOLDOWN_PROBE_DISABLED` | `0` | Kill switch for probe job |

---

## 11. Privacy & Security

- **No PII in logs**: Request bodies never logged. Only metadata (model, platform, tokens, latency, redacted errors).
- **Redaction first**: Console wrapper redacts before `server-logs` ever sees the line.
- **Single-user design**: No multi-tenant log isolation needed.
- **Local-first**: Logs never leave the machine unless operator configures external log shipper.

---

## 12. Tables

```sql
-- Server logs (warn/error only, persists across restarts)
CREATE TABLE server_logs (
  id INTEGER PRIMARY KEY,
  level TEXT CHECK(level IN ('trace','debug','info','warn','error')),
  source TEXT, provider TEXT, model TEXT, event TEXT, request_id TEXT,
  message TEXT, created_at_ms INTEGER
);

-- Per-request analytics
CREATE TABLE requests (
  id INTEGER PRIMARY KEY,
  platform TEXT, model_id TEXT, key_id INTEGER,
  request_type TEXT, status TEXT,
  input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
  latency_ms INTEGER, ttfb_ms INTEGER,
  error TEXT, created_at_ms INTEGER,
  client_info TEXT, served_model TEXT, attempt_error_summary TEXT
);

-- Per-attempt trail
CREATE TABLE request_attempts (
  id INTEGER PRIMARY KEY,
  request_id INTEGER, attempt_ordinal INTEGER,
  platform TEXT, model_id TEXT, key_id INTEGER,
  error_class TEXT, error_summary TEXT,
  latency_ms INTEGER, ttfb_ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER,
  FOREIGN KEY(request_id) REFERENCES requests(id)
);

-- Materialized aggregates (refreshed periodically)
CREATE VIEW request_aggregates AS ...;
```