# routes — Express 5 API handlers

**Relevant for:** adding or modifying HTTP endpoints  
**Depends on:** `services/` (router, ratelimit), `db/` (data access), `providers/` (model listing)

---

## Files

```
routes/
├── keys.ts       # CRUD for API keys (+ unified key display)
├── models.ts     # GET /v1/models — lists all seeded models
├── proxy.ts      # POST /v1/chat/completions — the main proxy endpoint
├── fallback.ts   # GET/PUT fallback chain ordering
├── analytics.ts  # GET usage analytics (24h/7d/30d)
├── health.ts     # GET /health — server & provider key status
└── settings.ts   # App-wide settings endpoint
```

All mounted in `app.ts` — each route file exports a single `Router` or function.

---

## Key patterns

- **`proxy.ts`** is the core — receives the OpenAI-format request, calls `routeRequest()` from services, handles both streaming (SSE) and non-streaming responses.
- **Auth middleware**: routes read `x-api-key` or `Authorization: Bearer <key>` header, validate against the DB. Proxy also supports no-auth for models that accept it.
- **CORS**: configured globally in `app.ts` via `DEFAULT_DASHBOARD_ORIGINS` from env. All routes inherit it.
- **Error shape**: all errors return `{ error: { message, type } }` with appropriate HTTP status. Handled centrally by `middleware/errorHandler.ts`.

---

## Conventions (this directory only)

- **No barrel** — each route file is imported individually in `app.ts`. No `routes/index.ts`.
- **No raw SQL** — DB access via `getDb()` + drizzle helpers. Raw `db.prepare()` is a violation.
- **Streaming proxy** writes SSE directly to the response — `res.write()` + `res.end()`. No Express middleware on the streaming path (it would buffer).

---

## Pitfalls

- **`proxy.ts` streaming path must handle partial writes** — if a provider sends malformed SSE chunks, the proxy silently drops the chunk rather than crashing the connection.
- **Auth is per-route** — there's no global auth middleware. Each route independently validates the key. If you add a new route, you must add auth handling.
- **Fallback chain order is persisted** — changing it via the API writes to SQLite and is restored on restart.
