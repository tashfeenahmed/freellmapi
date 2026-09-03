# API Domain — Overview & File Index

This domain documents FreeLLMAPI's OpenAI-compatible HTTP surface and its Anthropic/Gemini-compatible shims. The root [`README.md`](../README.md) and [`OVERVIEW.md`](../OVERVIEW.md) index this as the gateway's external contract.

## File Index

| File | Scope |
|------|-------|
| [`01-rest-api.md`](01-rest-api.md) | OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models`, streaming, tool calling, vision, video, Gemini grounding, response headers), the Anthropic Messages surface (`/v1/messages`), the pool-deduped free-tier budget API (`/api/free-tier`), and the encrypted backups API (`/api/backups`). |
| [`CHANGELOG.md`](CHANGELOG.md) | Doc revision history for this domain, seeded from API-relevant commits. |

## Navigation

- ← [Documentation root](../README.md)
- API reference: [`01-rest-api.md`](01-rest-api.md)

## Related

- [../clients/](../clients/) — Coding-agent integration recipes that consume this API.
- [../compression/](../compression/) — Request-side compression (`X-FreeLLM-Compress`) visible on API responses.
- [../architecture/](../architecture/) — Router, scoring, and streaming internals behind these endpoints.
