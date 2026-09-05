**English** · [简体中文](../../zh-cn/api/CHANGELOG.md)

# API Domain — Changelog

Doc revision history for `docs/api/`, seeded from API-relevant commits.

## 2026-09-03

- **docs(api): document the task-type routing header** — added `X-FreeLLM-Task-Type: code|chat|auto` (#1127) to the per-request headers section, with the weight shift it applies and the strategies that ignore it.
- **docs(api): document the task-weight-share setting** — added `GET/PUT /api/settings/task-weight-share` (#1127), the operator knob for how much weight the task-type bias moves.

## 2026-09-02

- **docs(api): add Idempotency-Key documentation (02-idempotency.md)** — documents non-streaming `POST /v1/chat/completions` idempotency from `36b877d` / `95bc46f`: `Idempotency-Key` header (trim + `≤255` UTF-8 bytes, first value on repeat), `replay` vs `409 idempotency_key_conflict` vs `miss` via `lookupIdempotencyReplay`, fingerprint `SHA-256(model+messages+temperature/top_p/max_tokens/tools/tool_choice)`, SHA-256 key-hash storage, `X-Routed-Via: idempotency` zero-cost replay, `stream:true` bypass and `finish_reason:length` not stored, in-flight NOT deduplicated (both attempts execute; pending-claim out of scope per `95bc46f` / `idempotency.ts:17-20`), `IDEMPOTENCY_TTL_MS` 24 h (`idempotencyTtlMs` + `envNum` guard, lazy sweep per `key_hash`), `409` handling, and a `curl` timeout→retry→replay example. Sources: `server/src/services/idempotency.ts`, `server/src/routes/proxy.ts:1793-1835` + `2640-2656`, migration `20260901_000001_idempotency_claims.ts`. Updated `docs/api/OVERVIEW.md` index and added cross-ref in `docs/architecture/04-degraded-mode-and-failover.md:10`.

## 2026-08-25

- **docs(api): document video platforms, free-tier budget, and backups APIs** — expanded `POST /v1/videos/generations` with the bounded pollinations/huggingface surface (5-minute timeout, fal queue); added `GET /api/free-tier` (pool-deduped monthly budget) and `GET /api/backups` (DUMP_FORMAT=1, sha256 key fingerprint) endpoint reference.

## 2026-08-23 — Docs reorganization

- **e8dde9e** `docs(api): fold API guide into api domain` — moved `docs/api.md` → `docs/api/01-rest-api.md` with `OVERVIEW.md` + `CHANGELOG.md` scaffold.

## 2026-08-10 and earlier

- **8cb75ac** feat(proxy): opt-in X-Fallback-Detail header with per-hop failover timings (#792)
- **878fb89** Add prompt and context compression pipeline (#628)
- **90d291d** Split README into focused docs pages (#627)

> Older history for this content is available via `git log --follow -- docs/api.md`.
