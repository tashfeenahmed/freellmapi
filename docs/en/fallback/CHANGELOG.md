# Fallback Domain — Changelog

Doc revision history for `docs/fallback/`, seeded from fallback-relevant commits.

## 2026-08-25

- **docs(fallback): scaffold fallback domain** — new `docs/fallback/` domain with `OVERVIEW.md` + `CHANGELOG.md`, and `01-named-chains.md` covering the chain lifecycle, the empty-chain `400` refusal (`activeChainOrThrow`), `auto:<name>` exposure in `GET /v1/models`, and `profiles.auto_include_new_models`, with the authoritative empty-chain commits `e852ff1`, `b3bf20f`, `8bb2004`, `cc1e985`.

## 2026-08-23 — Prerequisite history

- **e852ff1** Make a fallback chain mean itself, empty or not (#1023)
- **b3bf20f** Let a fallback chain be built by hand and stay that way (#1004)
- **8bb2004** Add a named chain manager to the Fallback page (#988)
- **cc1e985** List named fallback chains as `auto:<name>` models (#986)
