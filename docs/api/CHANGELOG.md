# API Domain — Changelog

Doc revision history for `docs/api/`, seeded from API-relevant commits.

## 2026-08-25

- **docs(api): document video platforms, free-tier budget, and backups APIs** — expanded `POST /v1/videos/generations` with the bounded pollinations/huggingface surface (5-minute timeout, fal queue); added `GET /api/free-tier` (pool-deduped monthly budget) and `GET /api/backups` (DUMP_FORMAT=1, sha256 key fingerprint) endpoint reference.

## 2026-08-23 — Docs reorganization

- **e8dde9e** `docs(api): fold API guide into api domain` — moved `docs/api.md` → `docs/api/01-rest-api.md` with `OVERVIEW.md` + `CHANGELOG.md` scaffold.

## 2026-08-10 and earlier

- **8cb75ac** feat(proxy): opt-in X-Fallback-Detail header with per-hop failover timings (#792)
- **878fb89** Add prompt and context compression pipeline (#628)
- **90d291d** Split README into focused docs pages (#627)

> Older history for this content is available via `git log --follow -- docs/api.md`.
