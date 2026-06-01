# FreeLLMAPI — Project Overview

**Generated:** 2026-05-31 | **Scan Level:** Exhaustive | **Repository Type:** Monorepo

## Executive Summary

FreeLLMAPI is a self-hosted, intelligent LLM API gateway that aggregates 17 free-tier AI provider endpoints behind a single, fully OpenAI-compatible `/v1/chat/completions` interface. It provides stateful failover routing, sliding-window rate-limit tracking, AES-256-GCM encrypted key storage, full-text session search (via SQLite FTS5), and a React dashboard for management — all running locally with a ~40MB idle memory footprint.

## Tech Stack Summary

| Category | Technology | Version |
|----------|-----------|---------|
| **Runtime** | Node.js | 22+ |
| **Language** | TypeScript | 5.8 / 6.0 |
| **Server Framework** | Express | 5.1 |
| **Client Framework** | React | 19.2 |
| **Build (Client)** | Vite | 8.0 |
| **CSS** | Tailwind CSS | 4.2 |
| **UI Components** | shadcn/ui + Base UI | 4.2 / 1.3 |
| **Data Fetching** | TanStack React Query | 5.97 |
| **Routing (Client)** | React Router | 7.14 |
| **Charts** | Recharts | 3.8 |
| **Database** | SQLite (better-sqlite3) | 12.4 |
| **Schema Validation** | Zod | 3.24 |
| **Testing** | Vitest | 3.1 |
| **Package Manager** | npm workspaces | — |

## Architecture Type

**Stateful API Gateway / Multi-Provider Proxy Aggregator** with a co-deployed management dashboard.

```
┌──────────────────────────────────────────────────────────┐
│  Client (Vite React SPA)                                 │
│  /playground, /keys, /fallback, /analytics               │
│  TanStack Query → /api/* REST endpoints                  │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTP (same origin / static serve)
┌──────────────────────▼───────────────────────────────────┐
│  Server (Express 5)                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐ │
│  │ /v1/* Proxy  │  │ /api/* CRUD │  │ Services Layer   │ │
│  │ completions  │  │ keys,models │  │ router, ratelimit│ │
│  │ models,      │  │ fallback,   │  │ health, memory   │ │
│  │ responses    │  │ analytics   │  │ (Hermes FTS5)    │ │
│  └──────┬──────┘  └──────┬──────┘  └────────┬─────────┘ │
│         │                │                    │           │
│  ┌──────▼────────────────▼────────────────────▼────────┐ │
│  │  Providers (17 adapters)                            │ │
│  │  Google · Groq · Cerebras · SambaNova · NVIDIA      │ │
│  │  Mistral · OpenRouter · GitHub · Cohere · Cloudflare│ │
│  │  Zhipu · Ollama · Kilo · Pollinations · LLM7       │ │
│  │  HuggingFace · MemOS                               │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  SQLite (WAL + FTS5)                                │ │
│  │  models · api_keys · requests · fallback_config     │ │
│  │  sessions · messages · messages_fts                 │ │
│  │  rate_limit_usage · rate_limit_cooldowns · settings │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## Repository Structure

```
freellmapi/                  # npm workspace root
├── package.json             # Workspace: [shared, server, client]
├── .env.example             # ENCRYPTION_KEY, PORT, DASHBOARD_ORIGINS
├── .github/workflows/ci.yml # CI pipeline
│
├── server/                  # @freellmapi/server — Express API gateway
│   ├── src/
│   │   ├── index.ts         # Entry point, DB init, health checker start
│   │   ├── app.ts           # Express setup, CORS, routes, SPA fallback
│   │   ├── routes/          # 7 route modules (proxy, keys, models, etc.)
│   │   ├── services/        # Business logic (router, ratelimit, memory, health)
│   │   ├── providers/       # 17 upstream adapters (5 custom + 12 OpenAI-compat)
│   │   ├── lib/             # Crypto (AES-256-GCM) + content normalization
│   │   ├── db/index.ts      # Schema (V1-V16 migrations), FTS5, write contention
│   │   ├── middleware/      # Error handler
│   │   ├── scripts/         # Provider sweep, test-all-models
│   │   └── __tests__/       # 21 test files, 154 tests
│   └── data/freellmapi.db   # WAL SQLite database
│
├── client/                  # @freellmapi/client — Vite React dashboard
│   ├── src/
│   │   ├── App.tsx          # Router: Playground, Keys, Fallback, Analytics
│   │   ├── pages/           # 4 page components
│   │   ├── components/      # shadcn/ui primitives + page-header
│   │   └── lib/             # API fetch helper
│   └── vite.config.ts
│
└── shared/                  # @freellmapi/shared — Shared types
    └── types.ts             # Platform, Model, ApiKey, ChatMessage, etc.
```

## Key Metrics

| Metric | Value |
|--------|-------|
| Source files | 70 |
| Total lines (TS/TSX) | 10,782 |
| Test files | 21 |
| Tests passing | 154 |
| Schema migrations | 16 (V1–V16) |
| Provider adapters | 17 |
| API endpoints | ~25 |
| Client pages | 4 |

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste the output as ENCRYPTION_KEY in .env

# 3. Start development (server + client)
npm run dev

# 4. Access
# API:       http://localhost:3001/v1/chat/completions
# Dashboard: http://localhost:5173
```
