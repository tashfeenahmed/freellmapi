# FreeLLMAPI — API Contracts

**Generated:** 2026-05-31 | **Part:** server

## OpenAI-Compatible Proxy

All proxy endpoints are mounted at `/v1` and accept standard OpenAI request/response formats.

### POST `/v1/chat/completions`

The primary proxy endpoint. Routes requests through the intelligent fallback chain.

**Request Body** (`ChatCompletionRequest`):
```json
{
  "model": "auto",
  "messages": [{"role": "user", "content": "Hello"}],
  "temperature": 0.7,
  "max_tokens": 1000,
  "stream": false,
  "tools": [{"type": "function", "function": {"name": "...", "parameters": {}}}],
  "tool_choice": "auto"
}
```

**Model Resolution:**
- `"auto"` or omitted → sticky routing (same model for 30-min window)
- Specific model ID → exact catalog match with `400 model_not_found` on invalid/disabled
- Partial match supported: `"claude-3"` matches `"anthropic/claude-3"`

**Response** (non-streaming):
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "gemini-2.0-flash",
  "choices": [{"index": 0, "message": {...}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
  "_routed_via": {"platform": "google", "model": "gemini-3.1-flash"}
}
```

**Streaming:** When `stream: true`, returns SSE chunks (`chat.completion.chunk`).

**Retry Logic:** Up to 3 attempts across fallback chain. On 429/5xx from upstream, the model is penalized and the next model in the chain is tried.

### GET `/v1/models`

Returns the model catalog in OpenAI-compatible format.

---

## Dashboard API

All dashboard endpoints are mounted at `/api`.

### Keys Management — `/api/keys`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/keys` | List all keys (masked) |
| POST | `/api/keys` | Add a new API key |
| DELETE | `/api/keys/:id` | Delete a key |
| PATCH | `/api/keys/:id` | Toggle key enabled/disabled |
| PATCH | `/api/keys/platform/:platform` | Toggle all keys for a platform |

**POST body** (Zod-validated):
```json
{
  "platform": "google",
  "key": "AIza...",
  "label": "My Google Key"
}
```

Valid platforms: `google`, `groq`, `cerebras`, `sambanova`, `nvidia`, `mistral`, `openrouter`, `github`, `cohere`, `cloudflare`, `zhipu`, `ollama`, `kilo`, `pollinations`, `llm7`, `huggingface`, `memos`

### Models — `/api/models`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models` | List all models with status |
| PATCH | `/api/models/:id` | Toggle model enabled/disabled |

### Fallback Configuration — `/api/fallback`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/fallback` | Get fallback chain (ordered by priority) |
| PUT | `/api/fallback` | Reorder fallback chain |
| PATCH | `/api/fallback/:modelDbId` | Toggle model in fallback chain |

### Analytics — `/api/analytics`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/analytics/summary?range=7d` | Summary stats (requests, success rate, tokens, cost savings) |
| GET | `/api/analytics/by-model?range=7d` | Stats grouped by model |
| GET | `/api/analytics/by-platform?range=7d` | Stats grouped by platform |
| GET | `/api/analytics/timeline?range=7d&interval=day` | Timeline data points |
| GET | `/api/analytics/error-distribution?range=7d` | Error distribution by category/platform |
| GET | `/api/analytics/errors?range=7d` | Recent error logs (limit 50) |

Query params: `range` = `24h` | `7d` | `30d`; `interval` = `hour` | `day`

### Health — `/api/health`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | System health with rate-limit status per model |
| POST | `/api/health/check` | Trigger manual health check of all keys |
| POST | `/api/health/check/:keyId` | Check a specific key |

### Settings — `/api/settings`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings/unified-key` | Get the unified API key |
| POST | `/api/settings/regenerate-key` | Regenerate the unified API key |

### Ping

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ping` | Simple health check (`{ status: "ok" }`) |

---

## Error Format

All errors follow the OpenAI standard envelope:

```json
{
  "error": {
    "message": "Detailed context message",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

## Authentication

- **Proxy endpoints** (`/v1/*`): Authenticated via `Authorization: Bearer <unified-key>` header. The unified key is auto-generated on first boot and stored in SQLite.
- **Dashboard endpoints** (`/api/*`): No authentication (localhost-only deployment model). CORS restricts browser access to configured `DASHBOARD_ORIGINS`.
