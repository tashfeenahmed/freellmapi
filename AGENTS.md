# AGENTS.md

## Architecture Overview

**FreeLLMAPI** is a monorepo with 3 packages:
- `shared/` - TypeScript types shared between server and client
- `server/` - Express.js API server + admin dashboard backend (port 3001)
- `client/` - React + Vite admin dashboard frontend (dev port 5173)

**Entry point**: `server/src/index.ts` - starts Express API and health checker

## Development Commands

```bash
npm install                    # Install all workspace dependencies
npm run dev                   # Start server:3001 + client:5173 concurrently
npm run test                  # Run server vitest tests
npm run build                 # Build both server and client
npm run build:server          # Build server only
```

## Critical Setup Requirements

### Encryption Key
**Required for production**: Generate a 64-character hex encryption key:
```bash
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
```

This encrypts API keys at rest in SQLite. Never use the dev fallback with real keys.

### Environment Variables
From `.env`:
- `ENCRYPTION_KEY` - Required for startup
- `PORT=3001` - Default server port
- `HOST_BIND=0.0.0.0` - Optional: expose to LAN (trust network only)

### Node Version
Requires **Node 20+** (`.nvmrc` specifies v20.19.5)

## Important Project Conventions

### Monorepo Structure
- Workspaces configured in root `package.json`
- Server and client built separately but run together in dev
- Shared types in `shared/types.ts`

### Testing
- Server uses Vitest with specific pool config
- Tests run in `server/src/__tests__/`
- `npm test` runs both server and client tests if present

### Database
- SQLite with AES-256-GCM encryption for API keys
- Data stored in `server/data/` (mounted as volume in Docker)
- Automatic schema management via Drizzle ORM

## Docker Deployment

```bash
docker compose up -d                    # Recommended: runs on localhost only
HOST_BIND=0.0.0.0 docker compose up -d # Expose to LAN (trust network only)
```

**Critical**: Keep the same `ENCRYPTION_KEY` and `freellmapi-data` volume when upgrading - encrypted keys cannot be decrypted with a different key.

## API Architecture

### Router Logic
- Main routing logic in `server/src/services/router.ts`
- Rate limiting per `(platform, model, key)` in `server/src/services/ratelimit.ts`
- Health checks in `server/src/services/health.ts`

### Provider Adapters
- One file per provider in `server/src/providers/*.ts`
- All implement `Provider` base class with `chatCompletion()` and `streamChatCompletion()`
- Wire new providers into `server/src/providers/index.ts`

### Key Management
- Admin dashboard at `/` (email + password auth)
- API proxy at `/v1/` (unified API key auth)
- Dashboard: http://localhost:3001
- API endpoint: http://localhost:3001/v1/chat/completions

## Development Workflow

### Local Development
```bash
cp .env.example .env
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
npm run dev
```

Server runs on port 3001, dashboard dev server on port 5173.

### Testing
- Server tests use Vitest with specific configuration
- Add new provider tests in `server/src/__tests__/providers/`
- Test both streaming and non-streaming implementations

## Build & Deployment

### Production Build
```bash
npm run build
node server/dist/index.js  # Combined server + dashboard on port 3001
```

### Docker Build
Image includes both server and built dashboard:
```bash
docker build -t freellmapi .
```

## Security Considerations

- **Single-user by design**: No multi-tenant auth
- **LAN-only exposure**: Never expose to internet without proper authentication
- **Encrypted keys**: API keys encrypted at rest with AES-256-GCM
- **Rate limiting**: Configurable proxy rate limiting per IP
- **ToS compliance**: Review provider terms of service before use

## Environment-Specific Behavior

- Development allows fallback to database-stored encryption key when `DEV_MODE=true`
- Production requires `ENCRYPTION_KEY` in environment
- Analytics retention: 90 days or 100,000 rows (configurable via `.env`)

## Common Pitfalls

- Missing `ENCRYPTION_KEY` will prevent server startup in production
- Different Node versions may cause compatibility issues
- Provider API changes may break routing logic
- Free tier limits cause 429 errors until catalog is updated