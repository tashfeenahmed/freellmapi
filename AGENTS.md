# FreeLLMAPI

**One OpenAI-compatible endpoint, 13+ free LLM providers bundled.**

Aggregates free tiers from Google, Groq, Cerebras, SambaNova, NVIDIA, Mistral,
OpenRouter, GitHub Models, Cohere, Cloudflare, Zhipu, HuggingFace, Ollama Cloud,
Kilo, Pollinations, and LLM7 behind a single `/v1/chat/completions` endpoint.
Router picks the best available model, falls over on 429/5xx, tracks per-key
rate limits, and encrypts API keys at rest.

---

## Structure

```
freellmapi/
├── shared/          # Shared TypeScript types (Platform, ChatMessage, etc.)
├── server/          # Express 5 proxy server
│   └── src/
│       ├── index.ts       # Entry point: init DB, create app, listen
│       ├── app.ts         # Express app setup, route mounting, static files
│       ├── providers/     # LLM provider adapters (base.ts + per-provider)
│       ├── routes/        # API route handlers (keys, models, proxy, etc.)
│       ├── services/      # Core business logic (router, ratelimit, health)
│       ├── middleware/     # Express middleware (errorHandler)
│       ├── lib/           # Utilities (crypto, content flattening)
│       ├── db/            # SQLite schema + migrations (drizzle-orm + better-sqlite3)
│       └── __tests__/     # Vitest tests (per-module subdirectories)
├── client/          # React 19 dashboard (Vite, shadcn/ui, Tailwind 4)
│   └── src/
│       ├── main.tsx       # React entry
│       ├── App.tsx        # Router setup
│       ├── components/    # UI components
│       ├── pages/         # Page-level views
│       └── lib/           # Client utilities
├── tests/           # Integration/e2e tests (sparse)
├── data/            # Runtime data (SQLite DB, etc.)
├── docs/            # Documentation assets
└── repo-assets/     # README images, screenshots
```

---

## Where to look

| Task | File |
|------|------|
| Add a new LLM provider | `server/src/providers/` — copy `openai-compat.ts` for REST-compatible APIs, or extend `base.ts` for custom formats. Register in `index.ts`. |
| Modify the router (model selection) | `server/src/services/router.ts` — priority sorting, rate-limit penalties, sticky sessions |
| Change rate-limit logic | `server/src/services/ratelimit.ts` — in-memory counters backed by SQLite |
| Add/modify API endpoints | `server/src/routes/` — one file per resource |
| Update DB schema / migrations | `server/src/db/index.ts` — drizzle-orm with better-sqlite3 |
| Encryption for API keys | `server/src/lib/crypto.ts` — AES-256-GCM |
| Dashboard UI changes | `client/src/` — React components, pages |
| Health check probes | `server/src/services/health.ts` |
| Shared types | `shared/types.ts` — Platform union, ChatCompletionRequest/Response, etc. |

---

## Conventions

- **ESM only** — all imports use `.js` extensions (`import { x } from './y.js'`)
- **TypeScript strict** — no `as any`, `@ts-ignore`, or `@ts-expect-error`
- **No path aliases** — imports are relative with `.js` extension
- **No Prettier** — formatting via editorconfig + `@eslint/js` defaults
- **Providers** extend `BaseProvider` (abstract class) with `chatCompletion()`, `streamChatCompletion()`, and `validateKey()`. OpenAI-compatible providers use `OpenAICompatProvider` with a config object.
- **Tests** co-located in `__tests__/` subdirectories matching source structure, using `vitest`
- **Error shape** — API errors return `{ error: { message, type } }` with HTTP status code
- **Env** — loaded in `server/src/env.ts` via dotenv; `ENCRYPTION_KEY` is required (unless `DEV_MODE=true`)

---

## Anti-patterns (avoid)

- **No `process.exit()` in library code** — the server catches startup errors gracefully
- **Don't skip the provider index** — every provider MUST be registered in `server/src/providers/index.ts`
- **No raw SQL** — use drizzle-orm helpers; the SQLite schema is managed in `server/src/db/index.ts`
- **No synchronous crypto** — key encryption/decryption is sync by design (better-sqlite3), but keep it minimal
- **Don't disable CSP/HSTS in production** — helmet's contentSecurityPolicy and hsts are intentionally off (see app.ts comment), only change if deploying publicly

---

## Commands

```bash
# Install
npm install

# Dev (server :3001 + dashboard :5173 with HMR)
npm run dev

# Build (server + client)
npm run build

# Test (server only; client tests are opt-in)
npm test

# Test server in watch mode
npm run test:watch -w server
```

---

## Notes

- Node **20+** required (CI runs on 20)
- `better-sqlite3` is a native module — `npm rebuild` if Node version changes
- All provider API keys are encrypted with AES-256-GCM before hitting SQLite
- The router uses an **in-memory penalty system** for 429s — penalties decay over 2 minutes
- Sticky sessions keep multi-turn conversations on the same model for 30 minutes
- The client is served as static files from `server/dist/` in production
