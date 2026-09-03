# Running tests

## Root chain

`npm test` at the repo root runs, in order ([package.json](../../package.json)):

| Step | Command | What it covers |
| --- | --- | --- |
| `test:bootstrap` | `node --test scripts/dev-bootstrap.test.mjs` | The dev bootstrap script. |
| `test:hooks` | `node --test .claude/hooks/contributing-check.test.mjs` | Contributor-check hook logic. |
| server | `npm run test -w server` | Vitest suite (see [02-server-suite.md](02-server-suite.md)). |
| cli | `npm run test -w cli` | Setup-CLI tests (tools, config-file merging, index). |
| client | `npm run test -w client --if-present` | Client vitest suite plus i18n parity check. |

The desktop workspace has its own small suite (`desktop/src/__tests__/window-chrome.test.ts`) but is not part of the root chain; it runs with its own tooling via `npm --prefix desktop`.

## Per-workspace commands

### Server (`server/package.json`)

```
npm run test -w server            # vitest run --pool=forks --fileParallelism=false
npm run test:watch -w server      # watch mode
npm run test:migrations -w server # migration roundtrip only
```

`test:migrations` targets exactly one file — [`src/__tests__/db/migrate/roundtrip.test.ts`](../../server/src/__tests__/db/migrate/roundtrip.test.ts) — and replays every recorded migration up and down to prove the roundtrip. Run it after touching anything under `src/db/migrate/`.

New test files added in the August 2026 batch that expand coverage:
- `src/__tests__/routes/logs.test.ts` — server log viewer persistence and API
- `src/__tests__/routes/custom-transcription.test.ts` — custom STT model registration and transcription usage
- `src/__tests__/lib/provider-identity.test.ts` — custom endpoint identity classification (#889)

### Client (`client/package.json`)

```
npm run test -w client            # vitest run && npm run check:i18n
npm run check:i18n -w client      # scripts/check-i18n.mjs
```

`check:i18n` verifies every locale file for key/placeholder parity; a missing or placeholder-broken translation fails the suite, not just the build.

### Everything else

`npm run build` must also pass — CI builds all workspaces after tests, so type errors surface there even when unit tests stay green.

## CI summary

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on `ubuntu-24.04`, on pushes and PRs targeting `main`, as a single `test` job across a Node matrix of **20 and 22** — both ends of the supported engines range (`>=20.18 <25`). Node 20 is the baseline that historically caught crashes newer local Node hid; 22 is the LTS most contributors run. Steps, in order:

1. checkout + setup-node (with npm cache)
2. `npm install`
3. **Check migration round trip**: `npm run test:migrations` (before the main suite, so schema drift fails fast)
4. `npm test` (the root chain above)
5. `npm run build`

`fail-fast: false` keeps one Node version's failure from hiding the other's results.
