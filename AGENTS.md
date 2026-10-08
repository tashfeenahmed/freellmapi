# AGENTS.md — 02-ai-freellmapi

OpenAI-compatible LLM API router aggregating free tiers from 34+ providers behind a single `/v1` endpoint. ~593 source files across a TypeScript monorepo.

## OVERVIEW

FreeLLMAPI collapses dozens of free-tier LLM providers into one OpenAI-compatible gateway. The router picks the best available model per request, falls over to the next provider on 429/5xx, and tracks per-key usage to stay under free-tier caps. Provider keys are AES-256-GCM encrypted in SQLite; clients see only a unified bearer token.

Supported surfaces: `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, `/v1/images/generations`, `/v1/videos/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/embeddings`, `/v1/models`. Also ships Anthropic Messages, native Gemini, and opt-in Ollama emulation.

## STRUCTURE

```
.
├── server/src/     # Express API (port 3001)
│   ├── providers/  # One file per provider; extend base.ts interface
│   ├── routes/     # Express route handlers (28 files)
│   ├── middleware/ # auth, rate limit, error handling
│   ├── services/   # router, catalog sync, ratelimit, scoring, compression
│   ├── lib/        # crypto, fallback loop, tool call rescue, etc.
│   └── db/         # better-sqlite3 migrations + types
├── client/src/     # React + Vite dashboard (React 19, Tailwind v4)
│   ├── components/ # 64 components, shadcn/ui-style
│   ├── i18n/       # 60 locales, flat JSON + locale-config.ts
│   └── lib/        # hooks, routing, playground stream
├── desktop/src/    # Electron app (port 31415 loopback only)
│   ├── main.ts     # app lifecycle, auto-update hooks
│   ├── tray.ts     # menu bar integration
│   ├── popover.ts  # glass popover overlay
│   └── window.ts   # dashboard window
├── cli/src/        # npx freellmapi setup-<tool> generators
├── shared/         # @freellmapi/shared — shared TypeScript types
├── docker/         # Multi-arch Dockerfile (no QEMU; ubuntu-24.04-arm runner)
├── scripts/        # dev-bootstrap.sh / .ps1, CI helpers
└── repo-assets/    # PNG/SVG assets for docs README
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add a provider | `server/src/providers/base.ts` then add to `index.ts`, seed models in `db/index.ts`, add test in `__tests__/providers/` |
| New API endpoint | `server/src/routes/<name>.ts` + wire in `app.ts` |
| Routing logic | `server/src/services/router.ts` + `lib/fallback-loop.ts` |
| Model catalog feed | `server/src/services/catalog-sync.ts` — signed Ed25519 feed |
| Rate tracking | `server/src/services/ratelimit.ts` — per (platform, model, key) counters |
| Compression pipeline | `server/src/services/compression/` — 8 engine types + registry |
| Client pages | `client/src/components/` — Keys, Models, Playground, Analytics |
| i18n strings | `client/src/i18n/locales/<lang>.json` — edit the value for the locale |
| Desktop bundle | `desktop/scripts/bundle-server.mjs` — stages built server into Electron |
| Database schema | `server/src/db/migrations/` — run `npm run db:migration:create` to scaffold |

## CONVENTIONS

- **Runtime**: Node >=20.18.0 <25.0.0, npm workspaces (`shared`, `server`, `client`, `cli`)
- **TypeScript**: strict mode, ES2022 target, bundler module resolution
- **Styling**: Tailwind CSS v4 on client; no component library beyond shadcn/ui primitives
- **Formatting**: Prettier — single quotes, 100 char print width, trailing comma es5
- **Testing**: Vitest (`--pool=forks --fileParallelism=false`) for server and client; CLI tests via vitest too
- **Provider contract**: implement the interface in `server/src/providers/base.ts`; return OpenAI-compatible shapes
- **Key encryption**: all provider keys are AES-256-GCM in SQLite; decrypted in-memory per request; never logged
- **Desktop port**: 31415 on loopback only; scan up on conflict and persist resolved port
- **Docker**: pinned image tags only. Native multi-arch builds via ubuntu-24.04-arm runner, no QEMU
- **Migrations**: timestamped filenames; use `npm run db:migration:create` to scaffold

## ANTI-PATTERNS

- Don't hardcode provider keys or API tokens anywhere in source
- Don't use `latest` Docker tag; pin to a specific digest or version
- Don't add a provider without an encrypted-key test in `__tests__/providers/`
- Don't commit `.env`, `keys.enc`, or any file containing plaintext secrets
- Don't run `npm rebuild` in `desktop/` for better-sqlite3; use `npm run rebuild:native`
- Don't edit `node_modules/` or `dist/` — they are build outputs, regenerated from source
- Don't bypass the catalog sync with local edits; the signed feed is the source of truth

## COMMANDS

```bash
npm install                        # bootstrap workspaces
npm run dev                        # server :3001 + client :5173 with HMR
npm run dev:lan                    # client exposed for LAN access
npm run desktop:dev                # build client, launch Electron app
npm run build                      # build server, cli, client
npm run test                       # all workspaces
npm run test:migrations            # DB migration roundtrip
npm run db:migration:create        # scaffold new migration
docker compose up -d               # starts server on :3001
npx freellmapi doctor --url <url> --api-key <key>
npx freellmapi setup-claude --url <url> --api-key <key>
```
