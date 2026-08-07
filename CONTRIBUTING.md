# Contributing to freellmapi

Contributors are very welcome. This project is a local-first aggregator for free LLM API tiers, so most contributions fall into a few buckets: adding a provider, adding an endpoint, improving the router, polishing the dashboard, or fixing bugs. The README has a "Good first PRs" list if you want a starting point.

AI agents contributing to this repo should read [`AGENTS.md`](AGENTS.md) first — it carries the always-on constraints (validation gates, commit style, security red lines).

## Development loop

```bash
npm install
npm run dev             # server on :3001, dashboard on :5173, both with HMR
npm run db:migration:up # apply all the migrations to your local database
npm test                # server vitest; also runs client tests if present
npm run build           # compile server and dashboard
```

For a repeatable local setup, run the bootstrap script for your shell. It only
installs dependencies when `package-lock.json` has changed and creates `.env`
when it is absent:

```powershell
.\scripts\dev-bootstrap.ps1
```

```bash
./scripts/dev-bootstrap.sh
```

Every PR should:

- Include a test, and keep the existing suite green (`npm test`).
- Match the `.editorconfig` and tsconfig defaults already in the repo.
- Stay scoped to one change. Smaller PRs get reviewed and merged faster.
- Avoid adding paid or card-gated services. This catalog only lists tiers that are genuinely free to start using without a credit card.

## Code style

- **Strict TypeScript**; derive types from zod schemas with `z.infer` (e.g. `SearchConfig`), don't hand-write duplicate interfaces
- **Naming**: camelCase variables/functions, PascalCase components/types, `_` prefix for private
- **i18n**: user-visible text goes through `t('key')`, never hardcoded strings; new keys are added to all 60 locales
- **Styling**: Tailwind utility classes + semantic CSS variables (`--muted-foreground`, etc.), never hardcoded hex
- **Time**: SQLite stores UTC (space-separated format); render in the viewer's local zone with `formatSqliteUtcToLocalTime`
- Don't refactor unrelated code; keep changes focused on one topic

## Validation (required before commit)

```bash
cd server && npx tsc --noEmit     # server types
cd client && npx tsc -b           # client types
npm run check:i18n                # 60 locales / key parity (run from client/)
```

- Add tests for new features (vitest: `server/src/__tests__`, `client/src/__tests__`)
- **Catalog / model changes**: verify live before submitting (`POST /v1/chat/completions` returns 200 on a free account); note the verification date and method in a comment / PR
- CI runs fmt / tsc / tests / i18n — run them locally first

## Database migrations

Schema changes must use file-per-migration files under
`server/src/db/migrations/`. Do not edit previously applied migration files.

Control database migrations with ([db/README.md](server/src/db/README.md)):

```bash
npm run db:migration:create --name=add_embedding_index
npm run db:migration:up
npm run db:migration:down
```

## Catalog conventions

- Add models in `server/src/db/model-pricing.ts` (pricing) + the migrations `additions` array
- `model_id` uses the exact `/v1/models` id (name:tag, e.g. `gpt-oss:20b`)
- **Free models only**: add only genuinely free models; ones that move to paid must be removed by a human (#722)
- Pricing mirrors the same model's paid variant where one exists; otherwise use a reasonable default and comment why
- Proof of availability goes in a code comment: verification date + method (e.g. "tested 2026-08-06 against Free tier")

## Commits

- Conventional Commits: `feat:` / `fix:` / `docs:` / `test:` / `style:` / `refactor:`
- Body explains the "why"; reference issues with `Refs #xxx`
- Append the `Co-Authored-By` trailer (for AI contributors)
- One PR per topic; don't mix unrelated changes

## Pull requests

PR description template:

```markdown
## What
(what changed, for the maintainer)

## Why
(why it should land; reference issues with `Refs #xxx`)

## Tests
(evidence: tsc result, test counts, live verification)

## Files
(key files touched)
```

- Report test evidence honestly; if you can't verify locally (e.g. no toolchain), say so and rely on CI
- **No half-finished work**: don't submit "stored but unused" code or fields (#590)
- Network: if github is unreachable, retry through the VPS proxy (`-x http://llmproxy:...@43.133.45.67:7890`)

## Translations

The dashboard ships 60 locales. `en.json` is the source of truth and every other file mirrors
its keys, so run `npm run check:i18n` from `client/` before opening a PR. See
[docs/translating.md](docs/translating.md) for the full rules and the settled Chinese
terminology.

## AI and LLM-assisted contributions

LLM-assisted PRs are welcome. A lot of this codebase is itself built that way, so there is no stigma here. The bar is the same as for any other PR: you are responsible for what you submit.

That means:

- **Understand your own diff.** If a reviewer asks why a line is there, you should be able to answer. Do not open a PR you cannot explain.
- **Test it for real.** Run the code, not just the prompt. Generated tests that do not actually exercise the change, or that pass against a mock of the wrong shape, are worse than no tests.
- **Keep it scoped.** Tools love to "helpfully" reformat unrelated files, rename things, or rewrite comments. Strip that out before opening the PR so the diff is only the change you intend.
- **No invented facts.** Provider rate limits, model ids, and endpoints must be verified against the provider, not recalled by a model. A wrong rate limit in the catalog is a bug that ships to everyone.
- **Disclose nothing special required.** You do not need to label a PR as AI-assisted. We care about the result, not the keystrokes.

PRs that are clearly unreviewed model output (broad unexplained diffs, fabricated limits, tests that do not run) will be asked for changes or closed.

## Security

- API keys surfaced only via `maskKey`; no plaintext in logs / PRs / comments
- Sensitive files 0o600; SSRF checks (`url-guard`); proxy / credential redaction (`redactProxyUrl`)
- Auth via the unified API key (`timingSafeStringEqual`), never trust socket locality
- For features touching sensitive data: discuss the permission / redaction approach before implementing

## Reporting issues

Bug reports are most useful with: your version (or commit), the provider involved, and the exact request and response where you can share them. For verification or routing bugs, the server logs around the failing request help a lot.

## Related community work

Some useful fixes and experiments live in community forks and branches. If you are looking for prior art before starting, these are worth a read:

- `fix-loopback-only` — restrict admin API access to localhost to avoid external exposure.
- `fix-35-admin-security` — optional `ADMIN_PASSWORD` HMAC auth for remote admin API access.
- `fix-101-markdown` — Markdown rendering in the Playground UI.
- `fix-119-atomic-ratelimits` — atomic SQLite `BEGIN IMMEDIATE` transactions to fix rate-limit race conditions.
- `feature-122-auto-routing` — per-request `smart` / `fast` / `cheap` routing strategies.

If you port one of these into a PR, credit the original author in the PR description so they land in the Contributors list.
