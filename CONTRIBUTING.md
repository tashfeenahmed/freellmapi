# Contributing

Contributors are very welcome. This project is a local-first aggregator for free LLM API tiers, so most contributions fall into a few buckets: adding a provider, adding an endpoint, improving the router, polishing the dashboard, or fixing bugs. The README has a "Good first PRs" list if you want a starting point.

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

## Database migrations

Schema changes must use file-per-migration files under
`server/src/db/migrations/`. Do not edit previously applied migration files.

Control database migrations with ([db/README.md](server/src/db/README.md)):

```bash
npm run db:migration:create --name=add_embedding_index
npm run db:migration:up
npm run db:migration:down
```

## Translations

The dashboard ships 60 locales. `en.json` is the source of truth and every other file mirrors
its keys, so run `npm run check:i18n` from `client/` before opening a PR. See
[docs/i18n/01-translating.md](docs/i18n/01-translating.md) for the full rules and the settled Chinese
terminology.

## Commit checklist hook

Optional, and off by default. If you use [Claude Code](https://claude.com/claude-code), the repo
ships a hook that reads this file and reminds the agent to check its diff against the rules above
before it runs `git commit` or `git push`. It reminds; it does not block.

See what it would say without enabling anything:

```bash
node .claude/hooks/contributing-check.mjs --preview
```

To turn it on, add this to your own `.claude/settings.local.json` — nothing is wired up for you:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/contributing-check.mjs\""
          }
        ]
      }
    ]
  }
}
```

This file is parsed when the hook fires, so editing the rules above changes what the agent is told
with no regeneration step.

## AI and LLM-assisted contributions

LLM-assisted PRs are welcome. A lot of this codebase is itself built that way, so there is no stigma here. The bar is the same as for any other PR: you are responsible for what you submit.

That means:

- **Understand your own diff.** If a reviewer asks why a line is there, you should be able to answer. Do not open a PR you cannot explain.
- **Test it for real.** Run the code, not just the prompt. Generated tests that do not actually exercise the change, or that pass against a mock of the wrong shape, are worse than no tests.
- **Keep it scoped.** Tools love to "helpfully" reformat unrelated files, rename things, or rewrite comments. Strip that out before opening the PR so the diff is only the change you intend.
- **No invented facts.** Provider rate limits, model ids, and endpoints must be verified against the provider, not recalled by a model. A wrong rate limit in the catalog is a bug that ships to everyone.
- **Disclose nothing special required.** You do not need to label a PR as AI-assisted. We care about the result, not the keystrokes.

PRs that are clearly unreviewed model output (broad unexplained diffs, fabricated limits, tests that do not run) will be asked for changes or closed.

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
