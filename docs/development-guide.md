# FreeLLMAPI — Development Guide

**Generated:** 2026-05-31

## Prerequisites

- **Node.js** 22+ (ESM support required)
- **npm** 10+ (workspace support)
- No external services required (SQLite is embedded, no Redis/PostgreSQL needed)

## Environment Setup

```bash
# Clone and install
git clone <repo-url>
cd freellmapi
npm install

# Generate encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Create .env from template
cp .env.example .env
# Paste the generated key as ENCRYPTION_KEY
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENCRYPTION_KEY` | **Yes** | — | 64-char hex key for AES-256-GCM key encryption |
| `PORT` | No | `3001` | Server listen port |
| `DASHBOARD_ORIGINS` | No | localhost:5173 | Comma-separated CORS origins for the dashboard |

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start server + client in watch mode (via `concurrently`) |
| `npm run dev -w server` | Start server only with `tsx watch` |
| `npm run dev -w client` | Start client only with Vite dev server |
| `npm test` | Run all tests (server + client) |
| `npm run test -w server` | Run server tests with Vitest |
| `npm run test:watch -w server` | Run server tests in watch mode |
| `npm run build` | Build server (tsc) + client (vite build) |
| `npm run build:server` | Build server only |

## Local Development URLs

| Service | URL |
|---------|-----|
| API Server | http://localhost:3001 |
| Vite Dashboard (dev) | http://localhost:5173 |
| Proxy Endpoint | http://localhost:3001/v1/chat/completions |
| Models Endpoint | http://localhost:3001/v1/models |

## Testing

Tests are written with **Vitest** and organized by domain in `server/src/__tests__/`:

```
__tests__/
├── db/              # Database schema idempotency
├── integration/     # End-to-end flow tests
├── lib/             # Crypto and content utilities
├── providers/       # Provider adapter correctness
├── routes/          # Route handler behavior
└── services/        # Business logic (router, ratelimit, memory)
```

**Run a specific test file:**
```bash
cd server && npx vitest run src/__tests__/services/memory.test.ts
```

**Current status:** 154 tests passing across 21 files.

## Project Structure Conventions

- **TypeScript files:** lowercase kebab-case (e.g., `error-handler.ts`)
- **React components:** PascalCase (e.g., `KeysPage.tsx`)
- **Test files:** Co-located in `__tests__/` mirroring `src/` structure
- **Database columns:** snake_case (e.g., `model_id`, `created_at`)
- **API responses:** camelCase JSON (e.g., `modelId`, `createdAt`)
- **Imports:** ESM with `.js` extensions (required by `"type": "module"`)

## Adding a New Provider

1. If OpenAI-compatible: register in `server/src/providers/index.ts`:
   ```typescript
   register(new OpenAICompatProvider({
     platform: 'newplatform',
     name: 'New Platform',
     baseUrl: 'https://api.example.com/v1',
   }));
   ```
2. If custom protocol: create `server/src/providers/newplatform.ts` extending `BaseProvider`
3. Add platform to `shared/types.ts` `Platform` union
4. Add platform to `PLATFORMS` array in `server/src/routes/keys.ts`
5. Add model catalog rows in a new migration (`migrateModelsV17`)

## Adding a Database Migration

Create a new function `migrateModelsVN` in `server/src/db/index.ts` and call it from `initDb()`. Use the idempotent pattern:

```typescript
function migrateModelsV17(db: Database) {
  // Use IF NOT EXISTS / column existence checks
  db.exec(`CREATE TABLE IF NOT EXISTS ...`);
  db.exec(`CREATE INDEX IF NOT EXISTS ...`);
  // For ALTER TABLE: check PRAGMA table_info first
}
```
