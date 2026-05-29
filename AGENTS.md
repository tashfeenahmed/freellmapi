# FreeLLMAPI

Aggregates free tiers from 13+ LLM providers behind a single OpenAI-compatible `/v1/chat/completions` endpoint. Node 20+, TypeScript, npm workspaces monorepo.

---

## Structure

```
freellmapi/
├── shared/            # Shared TypeScript types (Platform, Model, Chat, Analytics)
├── server/            # Express 5 proxy server
│   └── src/
│       ├── index.ts         # Entry: initDb → createApp → listen :3001
│       ├── app.ts           # Express factory: routes, CORS, helmet, static SPA
│       ├── providers/       # 14+ provider adapters (base + openai-compat + custom)
│       ├── routes/          # 7 API route files (keys, models, proxy, fallback, etc.)
│       ├── services/        # Core: router.ts, ratelimit.ts, health.ts
│       ├── middleware/      # errorHandler.ts
│       ├── lib/             # crypto.ts (AES-256-GCM), content.ts
│       ├── db/index.ts      # SQLite schema + 14 sequential migrations (1286 lines)
│       └── __tests__/       # Per-module test subdirs (vitest)
├── client/            # React 19 dashboard (Vite, shadcn/ui, Tailwind 4)
│   └── src/
│       ├── main.tsx        # React entry
│       ├── App.tsx         # BrowserRouter + QueryClientProvider + pages
│       ├── pages/          # KeysPage, AnalyticsPage, FallbackPage, PlaygroundPage
│       ├── components/     # shadcn/ui components + page-header
│       └── lib/            # api.ts (fetch wrapper), utils.ts (cn())
├── .github/workflows/ # CI: npm install → npm test → npm run build (Node 20)
├── docs/logos/        # Provider SVG icons
├── repo-assets/       # README screenshots
├── backups/           # SQLite DB snapshots (gitignored after first commit)
└── data/              # Empty — unused
```

---

## Where to look

| Task | File |
|------|------|
| Add a new LLM provider | `server/src/providers/` — copy `openai-compat.ts` for REST APIs, or extend `base.ts` for custom formats. Register in `index.ts`. Seed models in `db/index.ts`. |
| Modify router / model selection | `server/src/services/router.ts` — priority sort + dynamic 429 penalties + sticky sessions |
| Change rate-limit logic | `server/src/services/ratelimit.ts` — in-memory RPM/RPD/TPM/TPD + SQLite |
| Add/modify API route | `server/src/routes/` — mount in `app.ts` |
| Update DB schema / migrations | `server/src/db/index.ts` — append a new `migrateModelsV{N}()` call in `initDb()` |
| Key encryption | `server/src/lib/crypto.ts` — AES-256-GCM |
| Dashboard UI | `client/src/pages/` + `client/src/components/` |
| Dashboard API client | `client/src/lib/api.ts` |
| Shared types | `shared/types.ts` — `Platform`, `ChatCompletionRequest/Response`, etc. |
| CI pipeline | `.github/workflows/ci.yml` |
| Environment setup | `.env.example` — `ENCRYPTION_KEY` (64-char hex), `PORT`, `DASHBOARD_ORIGINS` |

---

## Conventions

- **ESM everywhere** — imports use `.js` extension in server (`import { x } from './y.js'`), `@/` alias in client (`import { x } from '@/lib/utils'`)
- **TypeScript strict** — server: `strict: true`. Client: individual strict flags (`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly`)
- **No path aliases in server** — all server imports are relative. Client uses `@/` → `./src/`
- **No Prettier** — formatting via `@eslint/js` defaults (client only). Server has no linter.
- **No barrel files** except `providers/index.ts` and `db/index.ts`. Individual route/service/lib files are imported directly.
- **Provider adapters** extend `BaseProvider` (abstract). OpenAI-compatible APIs use `OpenAICompatProvider(config)`. Custom formats (Google, Cohere, Cloudflare) get their own file.
- **Error shape** — `{ error: { message, type } }` with HTTP status code
- **Tests** — vitest, `__tests__/` subdirs mirroring source structure. HTTP tests use real Express + ephemeral ports + real `fetch()`. Provider tests mock `global.fetch`.
- **Env vars** — loaded via `server/src/env.ts` (dotenv from repo root `.env`)

---

## Anti-patterns

- **Don't skip `providers/index.ts`** — every provider MUST be registered here or `getProvider()` won't find it
- **No raw SQL in routes/services** — DB access goes through `db/index.ts` exports (`getDb()`). Direct `db.prepare()` is acceptable in tests.
- **No process.exit() in library code** — only in the entry point on fatal error
- **Migration numbering** — append new `migrateModelsV{N}()` in `db/index.ts`. Do NOT renumber or alter existing migrations.
- **Helmet CSP/HSTS** — intentionally disabled (see `app.ts` comment). Only enable if serving publicly over HTTPS.
- **`ENCRYPTION_KEY` is required** — dev-mode fallback (`DEV_MODE=true`) exists but must not be used with real API keys

---

## Commands

```bash
npm install          # Install all workspace deps
npm run dev          # Server (:3001) + dashboard (:5173) concurrently
npm run build        # tsc (server) + tsc -b && vite build (client)
npm test             # vitest run (server) + npm test (client, if-present)
npm run lint         # ESLint — client only
```

---

## Notes

- **Node 20+ required** — CI runs on Ubuntu with Node 20
- **`better-sqlite3` native module** — `npm rebuild` if Node version changes
- **Router uses in-memory penalty system** for 429s (2-min decay). Sticky sessions keep multi-turn on same model for 30 min.
- **Client is served as static files** from `server/dist/` in production — the Express app serves the dashboard as an SPA
- **Tests** set `process.env.ENCRYPTION_KEY = '0'.repeat(64)` before calling `initDb()` — needed for key crypto
- **CI** runs `npm test` then `npm run build` — no lint step, no Docker, no deploy
