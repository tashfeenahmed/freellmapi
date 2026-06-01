# FreeLLMAPI — Source Tree Analysis

**Generated:** 2026-05-31 | **Scan Level:** Exhaustive

## Annotated Directory Tree

```
freellmapi/                          # Monorepo root (npm workspaces)
├── package.json                     # Workspace definition: [shared, server, client]
├── package-lock.json                # Lockfile
├── .env                             # Runtime config (ENCRYPTION_KEY, PORT)
├── .env.example                     # Template for .env
├── .gitignore                       # Excludes node_modules, dist, data/
├── LICENSE                          # MIT License
├── README.md                        # Setup guide, usage, provider list (21KB)
│
├── .github/
│   └── workflows/
│       └── ci.yml                   # CI pipeline
│
├── docs/                            # Project documentation (this directory)
│
├── repo-assets/                     # Static assets for README
│
├── shared/                          # @freellmapi/shared — TypeScript types
│   ├── package.json                 # Name: @freellmapi/shared
│   └── types.ts                     # 230 lines: Platform, Model, ApiKey,
│                                    #   ChatMessage, ChatCompletionRequest,
│                                    #   ChatCompletionResponse, AnalyticsSummary,
│                                    #   RateLimitStatus, etc.
│
├── server/                          # @freellmapi/server — Express gateway
│   ├── package.json                 # Dependencies: express@5, better-sqlite3,
│   │                                #   zod, helmet, cors, dotenv, drizzle-orm
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   │
│   ├── data/
│   │   └── freellmapi.db            # WAL SQLite database (runtime artifact)
│   │
│   └── src/
│       ├── index.ts                 # ★ ENTRY POINT — initDb(), createApp(),
│       │                            #   listen(PORT), startHealthChecker()
│       ├── app.ts                   # Express init, CORS, route mounting,
│       │                            #   static serve + SPA fallback
│       ├── env.ts                   # dotenv loader (../../.env)
│       │
│       ├── routes/                  # HTTP route handlers
│       │   ├── proxy.ts             # ★ CORE — /v1/chat/completions, /v1/models
│       │   │                        #   Sticky routing, retry logic, stream/non-stream
│       │   ├── keys.ts              # /api/keys — CRUD with Zod validation
│       │   ├── models.ts            # /api/models — Catalog listing + toggle
│       │   ├── fallback.ts          # /api/fallback — Drag-and-drop chain ordering
│       │   ├── analytics.ts         # /api/analytics — 6 query endpoints
│       │   ├── health.ts            # /api/health — Key validation triggers
│       │   └── settings.ts          # /api/settings — Unified key management
│       │
│       ├── services/                # Business logic layer
│       │   ├── router.ts            # ★ CORE — Fallback chain + round-robin +
│       │   │                        #   dynamic 429 penalty + sticky sessions
│       │   ├── ratelimit.ts         # Sliding window RPM/RPD/TPM/TPD tracking
│       │   │                        #   with SQLite persistence + escalating cooldowns
│       │   ├── memory.ts            # Hermes session storage — FTS5 search,
│       │   │                        #   session lifecycle, lineage traversal (CTE)
│       │   └── health.ts            # Periodic key health checker (5-min interval)
│       │
│       ├── providers/               # Upstream API adapters
│       │   ├── index.ts             # Provider registry (Map<Platform, Provider>)
│       │   ├── base.ts              # Abstract BaseProvider interface
│       │   ├── openai-compat.ts     # Generic OpenAI-compatible adapter
│       │   │                        #   Used by: Groq, Cerebras, SambaNova, NVIDIA,
│       │   │                        #   Mistral, OpenRouter, GitHub, Zhipu, Ollama,
│       │   │                        #   Kilo, Pollinations, LLM7, HuggingFace
│       │   ├── google.ts            # Google Gemini native adapter (non-OpenAI)
│       │   ├── cohere.ts            # Cohere Command adapter (partial compat)
│       │   ├── cloudflare.ts        # Cloudflare Workers AI (account_id:token)
│       │   └── memos.ts            # MemOS adapter (fully custom protocol)
│       │
│       ├── lib/                     # Shared utilities
│       │   ├── crypto.ts            # AES-256-GCM encrypt/decrypt/maskKey
│       │   └── content.ts           # ChatContentBlock[] → string flattener
│       │
│       ├── db/
│       │   └── index.ts             # ★ CORE — Schema definitions, V1-V16
│       │                            #   migrations, FTS5 setup, write contention
│       │                            #   (runWithRetry), WAL checkpointing
│       │
│       ├── middleware/
│       │   └── errorHandler.ts      # Express error boundary
│       │
│       ├── scripts/                 # Development utilities
│       │   ├── provider-sweep.ts    # Probe all providers for health
│       │   └── test-all-models.ts   # Test every catalog model
│       │
│       └── __tests__/               # Test suite (21 files, 154 tests)
│           ├── db/
│           │   └── idempotency.test.ts
│           ├── integration/
│           │   └── full-flow.test.ts
│           ├── lib/
│           │   ├── content.test.ts
│           │   ├── crypto-init.test.ts
│           │   └── crypto.test.ts
│           ├── providers/
│           │   ├── cloudflare.test.ts
│           │   ├── cohere.test.ts
│           │   ├── google-schema.test.ts
│           │   ├── google.test.ts
│           │   └── openai-compat.test.ts
│           ├── routes/
│           │   ├── fallback.test.ts
│           │   ├── keys.test.ts
│           │   ├── proxy-array-content.test.ts
│           │   ├── proxy-auth-cors.test.ts
│           │   ├── proxy-auto-model.test.ts
│           │   ├── proxy-retry.test.ts
│           │   └── proxy-tools.test.ts
│           └── services/
│               ├── memory.test.ts
│               ├── ratelimit.test.ts
│               ├── router.test.ts
│               └── routing-exhaustion.test.ts
│
└── client/                          # @freellmapi/client — React dashboard
    ├── package.json                 # Dependencies: react@19, vite@8,
    │                                #   tailwindcss@4, shadcn, tanstack/react-query,
    │                                #   recharts, react-router-dom@7, dnd-kit
    ├── vite.config.ts               # Vite config with React plugin
    ├── tsconfig.json
    ├── tsconfig.app.json
    ├── tsconfig.node.json
    ├── eslint.config.js
    ├── index.html                   # SPA entry
    ├── components.json              # shadcn/ui component config
    │
    └── src/
        ├── main.tsx                 # React root mount
        ├── App.tsx                  # ★ ENTRY — Router with 4 pages:
        │                            #   /playground, /keys, /fallback, /analytics
        │                            #   + dark mode toggle + navigation bar
        ├── index.css                # Tailwind CSS base + theme variables
        ├── vite-env.d.ts
        │
        ├── pages/
        │   ├── PlaygroundPage.tsx   # Chat playground for testing models
        │   ├── KeysPage.tsx         # API key management (add/delete/toggle)
        │   ├── FallbackPage.tsx     # Drag-and-drop fallback chain ordering
        │   └── AnalyticsPage.tsx    # Usage charts, error distribution
        │
        ├── components/
        │   ├── page-header.tsx      # Reusable page header component
        │   └── ui/                  # shadcn/ui primitives
        │       ├── badge.tsx
        │       ├── button.tsx
        │       ├── card.tsx
        │       ├── input.tsx
        │       ├── label.tsx
        │       ├── select.tsx
        │       ├── separator.tsx
        │       ├── switch.tsx
        │       ├── table.tsx
        │       └── textarea.tsx
        │
        └── lib/
            ├── api.ts               # Generic fetch wrapper with error handling
            └── utils.ts             # clsx/tailwind-merge utility
```

## Critical Folders

| Folder | Purpose | Impact |
|--------|---------|--------|
| `server/src/db/` | Schema, migrations, write contention | Core data layer |
| `server/src/routes/proxy.ts` | Primary proxy endpoint | Core business logic |
| `server/src/services/router.ts` | Fallback chain + routing | Request dispatching |
| `server/src/providers/` | All upstream integrations | Provider connectivity |
| `server/src/services/memory.ts` | Hermes session storage | Knowledge persistence |
| `client/src/pages/` | All UI pages | User-facing dashboard |

## Integration Points

The **server** serves the **client** as static files from `client/dist/` in production. The client communicates with the server via REST (`/api/*`) using `TanStack React Query`. The shared workspace provides type-safe contracts between both parts via `@freellmapi/shared/types.js`.

```
client (React SPA)
  │
  ├── /api/keys       → server/routes/keys.ts
  ├── /api/models     → server/routes/models.ts
  ├── /api/fallback   → server/routes/fallback.ts
  ├── /api/analytics  → server/routes/analytics.ts
  ├── /api/health     → server/routes/health.ts
  ├── /api/settings   → server/routes/settings.ts
  └── /v1/*           → server/routes/proxy.ts → 17 upstream providers
```
