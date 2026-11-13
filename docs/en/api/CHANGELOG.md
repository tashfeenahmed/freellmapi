**English** · [简体中文](../../zh-cn/api/CHANGELOG.md)

# API Domain — Changelog

Doc revision history for `docs/api/`, seeded from API-relevant commits.

## 2026-10-23

- **fix(api): client-profile keys now authenticate `/v1/messages` and `/v1beta`** — the `sk-cp-*` keys from #411 were accepted only by `/v1/chat/completions` and `/v1/responses`; the Anthropic and Gemini surfaces still compared the unified key alone, so a downstream app speaking the Claude or Gemini wire format got `401` with its own profile key. Both routes now resolve through `resolveAuth`: profile keys carry their server-enforced system prompt (injected first, after compression on `/v1/messages`, ahead of `systemInstruction` on `/v1beta` — same ordering contract), and a disabled profile fails like a bad key. Source: `server/src/routes/anthropic.ts`, `server/src/routes/gemini.ts`.

## 2026-10-20

- **docs(api): document `GET /v1/usage`** — the endpoint shipped with #1600 and gained a per-key breakdown in #1614 but was never in `01-rest-api.md`. Added a Usage API section: response shape (`month`, `resetsAt`, `requests`, `tokens`, `byPlatform[]`, `byKey[]` with `requestCap`/`tokenCap`, `null` = unlimited), unified-key-only auth (`403` for client profiles), deleted keys surfacing under platform `removed`, and the ledger-not-clamped-at-cap semantics that match `429 quota_exceeded`. Source: `server/src/routes/proxy.ts` (`GET /v1/usage` handler).

## 2026-09-03

- **docs(api): document the task-type routing header** — added `X-FreeLLM-Task-Type: code|chat|auto` (#1127) to the per-request headers section, with the weight shift it applies and the strategies that ignore it.
- **docs(api): document the task-weight-share setting** — added `GET/PUT /api/settings/task-weight-share` (#1127), the operator knob for how much weight the task-type bias moves.

## 2026-09-02

- **docs(api): add Idempotency-Key documentation (02-idempotency.md)** — documents non-streaming `POST /v1/chat/completions` idempotency from `36b877d` / `95bc46f`: `Idempotency-Key` header (trim + `≤255` UTF-8 bytes, first value on repeat), `replay` vs `409 idempotency_key_conflict` vs `miss` via `lookupIdempotencyReplay`, fingerprint `SHA-256(model+messages+temperature/top_p/max_tokens/tools/tool_choice)`, SHA-256 key-hash storage, `X-Routed-Via: idempotency` zero-cost replay, `stream:true` bypass and `finish_reason:length` not stored, in-flight NOT deduplicated (both attempts execute; pending-claim out of scope per `95bc46f` / `idempotency.ts:17-20`), `IDEMPOTENCY_TTL_MS` 24 h (`idempotencyTtlMs` + `envNum` guard, lazy sweep per `key_hash`), `409` handling, and a `curl` timeout→retry→replay example. Sources: `server/src/services/idempotency.ts`, `server/src/routes/proxy.ts:1793-1835` + `2640-2656`, migration `20260901_000001_idempotency_claims.ts`. Updated `docs/en/api/OVERVIEW.md` index and added cross-ref in `docs/architecture/04-degraded-mode-and-failover.md:10`.

## 2026-08-25

- **docs(api): document video platforms, free-tier budget, and backups APIs** — expanded `POST /v1/videos/generations` with the bounded pollinations/huggingface surface (5-minute timeout, fal queue); added `GET /api/free-tier` (pool-deduped monthly budget) and `GET /api/backups` (DUMP_FORMAT=1, sha256 key fingerprint) endpoint reference.

## 2026-08-23 — Docs reorganization

- **36850e8** `docs(api): fold API guide into api domain` — moved `docs/api.md` → `docs/api/01-rest-api.md` with `OVERVIEW.md` + `CHANGELOG.md` scaffold. (landed via #979)

## 2026-08-10 and earlier

- **8cb75ac** feat(proxy): opt-in X-Fallback-Detail header with per-hop failover timings (#792)
- **878fb89** Add prompt and context compression pipeline (#628)
- **90d291d** Split README into focused docs pages (#627)

> Older history for this content is available via `git log --follow -- docs/api.md`.
