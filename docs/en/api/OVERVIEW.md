# API Domain — Overview & File Index

This domain documents FreeLLMAPI's OpenAI-compatible HTTP surface and its Anthropic/Gemini-compatible shims. The root [`README.md`](../README.md) and [`OVERVIEW.md`](../OVERVIEW.md) index this as the gateway's external contract.

## File Index

| File | Scope |
|------|-------|
| [`01-rest-api.md`](01-rest-api.md) | OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models`, streaming, tool calling, vision, video, Gemini grounding, response headers), the Anthropic Messages surface (`/v1/messages`), the pool-deduped free-tier budget API (`/api/free-tier`), and the encrypted backups API (`/api/backups`). |
| [`02-idempotency.md`](02-idempotency.md) | `Idempotency-Key` on non-streaming `POST /v1/chat/completions` — `replay` vs `409 conflict` vs `miss`, fingerprint composition (`model`+`messages`+`temperature`/`top_p`/`max_tokens`/`tools`/`tool_choice`), SHA-256 key-hashing, non-streaming-only, in-flight NOT deduplicated (95bc46f), 24 h `IDEMPOTENCY_TTL_MS` window, `X-Routed-Via: idempotency`, curl retry example. Sources: `server/src/services/idempotency.ts`, `proxy.ts:1793-1835`. |
| [`CHANGELOG.md`](CHANGELOG.md) | Doc revision history for this domain, seeded from API-relevant commits. |

## Navigation

- ← [Documentation root](../README.md)
- API reference: [`01-rest-api.md`](01-rest-api.md) · [`02-idempotency.md`](02-idempotency.md)

## Related

- [../clients/](../clients/) — Coding-agent integration recipes that consume this API.
- [../compression/](../compression/) — Request-side compression (`X-FreeLLM-Compress`) visible on API responses.
- [../architecture/](../architecture/) — Router, scoring, and streaming internals behind these endpoints.
