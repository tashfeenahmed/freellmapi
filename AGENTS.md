# AGENTS.md — freellmapi development constraints (always-on context for AI agents)

> This file is the always-on context handed to AI coding agents working on this
> repo. `CLAUDE.md` can link to it. Every line passes the test: "would removing
> this cause the agent to make a mistake it wouldn't otherwise make?" Full
> details live in `CONTRIBUTING.md`.
> When a constraint conflicts with the current code, the code wins — note the
> discrepancy, then fix the doc or the implementation.

## Project at a glance

- **freellmapi**: free-LLM API gateway/proxy (OpenAI / Anthropic compatible)
- **Stack**: Node + Express + better-sqlite3 (`server/`), React + Vite + Tailwind (`client/`)
- **Key data**: models (catalog + routing scores), api_keys (credentials), requests (usage / latency / TTFB), attempt-trace (retry chains)

## Code conventions (project-specific)

- **i18n**: all user-visible text goes through `t('key')`, never hardcoded strings; new keys must be added to all locales (`check:i18n`, 60 locales)
- **Styling**: Tailwind utility classes + semantic CSS variables (`--muted-foreground`, etc.), never hardcoded hex
- **Types**: derive from zod schemas with `z.infer` (e.g. `SearchConfig`), don't hand-write duplicate interfaces
- **Time**: SQLite stores UTC (space-separated `YYYY-MM-DD HH:MM:SS`); render in the viewer's local zone with `formatSqliteUtcToLocalTime`

## Validation (required before commit)

- server: `cd server && npx tsc --noEmit`
- client: `cd client && npx tsc -b`
- i18n: `npm run check:i18n`
- add tests for new features; **catalog / model changes must be verified live** (200 + free account, note the verification date and method)

## Commit style

- Conventional Commits (`feat:` / `fix:` / `docs:` / `test:` / `style:` / `refactor:`)
- Body explains the "why"; reference issues with `Refs #xxx`
- One PR per topic; split features into focused PRs

## Security red lines (do-first)

- API keys surfaced only via `maskKey`; no plaintext in logs / PRs / comments
- Sensitive files 0o600; SSRF checks (`url-guard`); proxy / credential redaction (`redactProxyUrl`)
- Auth via the unified API key (`timingSafeStringEqual`), never trust socket locality

## Key constraints

- **No half-finished work**: don't submit "stored but unused" code or fields (#590)
- **Free models only**: add only genuinely free models; ones that move to paid must be removed by a human (#722)
- Model ids use the exact `/v1/models` id (name:tag convention)
- Network: if github is unreachable, retry through the VPS proxy

## References

- `CONTRIBUTING.md` — full development flow (setup / style / validation / catalog / PR)
- `docs/` (`api.md`, `architecture.md`) — architecture and protocol details
