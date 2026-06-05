# FreeLLMAPI — Project Documentation Index

**Generated:** 2026-05-31 | **Scan Level:** Exhaustive | **Source Files:** 70 | **Lines:** 10,782

## Project Overview

- **Type:** Monorepo with 3 parts (server, client, shared)
- **Primary Language:** TypeScript
- **Architecture:** Stateful API Gateway / Multi-Provider LLM Proxy
- **Providers:** 17 free-tier AI platforms
- **Database:** SQLite (WAL + FTS5 + Hermes Session Storage)

## Quick Reference

### Server (`@freellmapi/server`)

- **Type:** Backend API Gateway
- **Tech Stack:** Express 5, better-sqlite3, Zod, Vitest
- **Entry Point:** `server/src/index.ts`
- **Root:** `server/`

### Client (`@freellmapi/client`)

- **Type:** Web SPA Dashboard
- **Tech Stack:** React 19, Vite 8, Tailwind CSS 4, shadcn/ui, TanStack Query, Recharts
- **Entry Point:** `client/src/App.tsx`
- **Root:** `client/`

### Shared (`@freellmapi/shared`)

- **Type:** TypeScript Types Library
- **Entry Point:** `shared/types.ts`
- **Root:** `shared/`

## Generated Documentation

- [Project Overview](./project-overview.md)
- [Architecture — Server](./architecture-server.md)
- [Architecture — Client](./architecture-client.md)
- [Source Tree Analysis](./source-tree-analysis.md)
- [Component Inventory — Client](./component-inventory-client.md)
- [Development Guide](./development-guide.md)
- [API Contracts — Server](./api-contracts-server.md)
- [Data Models — Server](./data-models-server.md)
- [Integration Architecture](./integration-architecture.md)

## Existing Documentation

- [README](../README.md) — Setup guide, provider list, usage instructions

## Getting Started

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Set ENCRYPTION_KEY in .env

# 3. Run
npm run dev

# 4. Access
# Dashboard: http://localhost:5173
# API:       http://localhost:3001/v1/chat/completions
```

## For AI Agents

When working on this codebase, start here:

- **Adding a feature:** Read [Architecture — Server](./architecture-server.md) and [Integration Architecture](./integration-architecture.md)
- **Adding a provider:** See "Adding a New Provider" in [Development Guide](./development-guide.md)
- **Database changes:** See "Adding a Database Migration" in [Development Guide](./development-guide.md) and [Data Models](./data-models-server.md)
- **UI changes:** Read [Architecture — Client](./architecture-client.md) and [Component Inventory](./component-inventory-client.md)
- **Understanding routing:** See `routeRequest()` flow in [Architecture — Server](./architecture-server.md)
