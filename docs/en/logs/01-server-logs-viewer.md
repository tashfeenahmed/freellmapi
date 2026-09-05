# Server Logs Viewer

The dashboard includes a live **Server Logs** viewer (accessible from the
Analytics nav menu) that surfaces the same diagnostic lines the server prints to
stdout — routing decisions, provider health checks, key cooldowns, quota
exhaustion, compression fidelity gates, and any `warn`/`error` level events —
without requiring SSH or container log access.

> **Implementation internals:** the ingest path, structured `providerLog` metadata, boot preload, the `server_logs` / `requests` / `request_attempts` schema, and the desktop file logger (`freeapi.log`) are covered in the [Observability deep-dive](../architecture/06-observability.md). This guide covers the operator-facing dashboard, polling API, and client implementation.

---

## Two-tier store

The log store uses **one id space across two tiers**:

| Tier | Capacity | Levels | Persistence | Purpose |
| --- | --- | --- | --- | --- |
| **Ring buffer** | 1,000 entries (newest) | `trace`, `debug`, `info`, `warn`, `error` | In-memory only | Live tail for the polling dashboard; survives filter changes, not restarts. |
| **`server_logs` table** | Configurable (`SERVER_LOGS_MAX_ROWS`, default 50,000) | `warn`, `error` only | SQLite (survives restart) | Durable history for the warnings/errors that matter most. |

- **Ids are assigned by the store**, not by SQLite. The counter is seeded from
  `MAX(id)` at initialization so ids keep increasing across restarts. A
  dashboard tab holding a `sinceId` cursor never sees it go backwards.
- At startup the store **preloads up to 200 recent persisted rows** (newest
  first) into the ring so the dashboard shows the warnings that preceded the
  restart instead of an empty panel.
- Capture happens **inside the redaction wrapper** (`lib/log-redaction.ts`).
  There is exactly one console patch in the process; it redacts first, then
  the store only ever sees the redacted form. Secrets never reach the ring or
  the database.
- Lines matching `GET|HEAD /api/(logs|ping)` are filtered out at ingest to
  prevent a self-feeding buffer (the polling endpoint would otherwise be the
  loudest thing in the log).

---

## API contract

All endpoints are mounted under `/api/logs` behind the dashboard session gate
(the unified `/v1` key opens the inference surface, **never** this one — these
lines name providers, models, key ids, and failure reasons).

### `GET /api/logs` — Polling endpoint

Cursor-based pagination built for a dashboard that polls every few seconds.

| Query param | Type | Description |
| --- | --- | --- |
| `sinceId` | `integer` (optional) | Return entries **newer** than this id. Omit for the newest `limit` entries (default 200). The cursor returned as `nextId` is the store's highest id, not the highest id returned — so a poll whose matches were all filtered still advances the cursor instead of re-scanning the same tail forever. |
| `levels` | `csv` (optional) | Comma-separated level filter: `trace,debug,info,warn,error`. Unknown levels return `400`. |
| `q` | `string` (optional) | Case-insensitive text search across `message`, `provider`, `source`, `event`. |
| `provider` | `string` (optional) | Exact provider name filter (e.g., `openai`, `anthropic`). |
| `limit` | `integer` (optional) | Clamped to `[1, 500]`, default `200`. |

**Response:**

```json
{
  "entries": [
    {
      "id": 12345,
      "ts": "2026-08-23T14:32:11.123Z",
      "level": "warn",
      "source": "CooldownProbe",
      "provider": "openai",
      "model": "gpt-4o",
      "event": "cooldown_triggered",
      "requestId": "req_abc123",
      "message": "[CooldownProbe] openai:gpt-4o key #3 entered 45s cooldown (rate limit)"
    }
  ],
  "nextId": 12345,
  "counts": { "debug": 12, "info": 145, "warn": 8, "error": 2 }
}
```

- `trace` is folded into `debug` in the counts (the dashboard shows four badges).
- The `entries` array is **oldest → newest** within the returned page.
- An already-caught-up caller (`sinceId >= lastId`) gets `entries: []` for the
  cost of one integer comparison.

### `GET /api/logs/counts` — Level counts

Returns the same `LogLevelCounts` object included in every poll response, so a
page that only wants the badge numbers can fetch them once without the full
entry payload.

```json
{ "debug": 12, "info": 145, "warn": 8, "error": 2 }
```

### `POST /api/logs/clear` — Clear both tiers

Empties the ring buffer **and** truncates the `server_logs` table. The id
counter is **not reset** — a dashboard tab holding a cursor would otherwise be
handed ids it has already seen.

```json
{ "ok": true }
```

---

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SERVER_LOGS_RETENTION_DAYS` | `7` | Rows older than this many days are deleted by a daily maintenance job (see `server/src/jobs/prune-logs.ts`). |
| `SERVER_LOGS_MAX_ROWS` | `50000` | Hard cap on the `server_logs` table. When exceeded, oldest rows are deleted on the next insert. |

Both are read at server boot; changing them requires a restart.

---

## Redaction integration

The store is a **tap inside `lib/log-redaction.ts`**, not a second console
wrapper. The flow:

1. Application code calls `console.log` / `providerLog()` / etc.
2. The redaction wrapper intercepts, scrubs secrets (API keys, Bearer tokens,
   URL tokens, etc.), and emits the clean line to the **original** stdout.
3. The wrapper **then** calls `recordConsoleLine()` / the store receives the
   already-redacted text.
4. `providerLog()` (used for structured operational events) redacts its own
   message before recording, then mirrors to the wrapped console — idempotent
   under a second pass.

Result: **secrets never enter the ring buffer or the database**, and operators
see exactly the same lines in the dashboard that they would see in the terminal.

---

## Client implementation notes (`client/src/pages/LogsPage.tsx`)

- **Polling interval:** 3 seconds (`LOG_POLL_MS`), paused when the tab is
  backgrounded (`refetchIntervalInBackground: false`).
- **Filter changes** (level checkboxes, provider dropdown, search box) reset the
  stream: buffer cleared, cursor nulled, new query key → fresh newest-200 page.
- **Search debounce:** 300 ms (`SEARCH_DEBOUNCE_MS`).
- **Tail-follow:** The view auto-scrolls only while the user is parked at the
  bottom (within 40 px). Scrolling up detaches; a "Jump to latest" pill appears
  when new lines arrive while detached.
- **Entry buffer:** Capped at 500 entries (`LOG_BUFFER_LIMIT`) in component
  state; oldest evicted as new pages arrive.
- **Expandable rows:** Long messages (> 300 chars) are clamped with a
  "Show more/less" toggle.
- **Level badges:** Color-coded per severity (error=red, warn=amber, info=blue,
  debug=muted) with live counts from the `counts` payload.
- **Provider dropdown:** Populated dynamically from the `provider` field of
  entries seen in the current stream.
- **Clear button:** Confirmed action calling `POST /api/logs/clear`, then
  invalidates the query cache and resets local state.

---

## Navigation

The Logs page is linked from the **Analytics** nav menu
(`client/src/pages/AnalyticsPage.tsx` → sidebar). It sits alongside the
analytics charts as a diagnostic companion: the charts show *what* happened
(request volumes, latencies, errors); the logs show *why*.