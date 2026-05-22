# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**FreeLLMAPI** — OpenAI-compatible proxy that aggregates free LLM provider tiers (Google Gemini, Groq, Cerebras, SambaNova, Mistral, OpenRouter, GitHub Models, Cloudflare, Cohere, Z.ai, NVIDIA, Ollama Cloud) behind a single `/v1/chat/completions` endpoint. Features encrypted key storage, automatic fallover, per-key rate tracking, multi-turn session stickiness, and an admin dashboard.

Monorepo: `server` (Express + TypeScript), `client` (React + Vite), `shared` (types).

## Architecture

### Server (`server/src/`)

- **`index.ts`** — Entry point; boots DB, creates Express app, starts health checker.
- **`app.ts`** — Express setup; mounts all routes and client static files.
- **`routes/`** — API endpoints:
  - `proxy.ts` — `/v1/chat/completions` and `/v1/models` (OpenAI-compatible).
  - `keys.ts` — CRUD for provider API keys (encrypted).
  - `fallback.ts` — Reorder model priority chain.
  - `analytics.ts` — Per-request logging (latency, tokens, provider breakdown).
  - `health.ts` — Poll key status.
  - `settings.ts` — User settings.
  - `models.ts` — List available models.
- **`providers/`** — One adapter per LLM provider.
  - `base.ts` — Abstract `BaseProvider` with `chatCompletion()`, `streamChatCompletion()`, `validateKey()`.
  - `openai-compat.ts` — Template for OpenAI-compatible providers (Groq, Mistral, SambaNova, OpenRouter, GitHub Models, Cohere, Cloudflare).
  - Provider-specific implementations: `google.ts`, `cohere.ts`, etc. Override base class when provider APIs diverge from OpenAI format.
- **`services/`**:
  - `router.ts` — Picks best available model per request (considers rate limits, health, priority).
  - `ratelimit.ts` — In-memory RPM/RPD/TPM/TPD ledger + SQLite persistence; cooldowns on 429s.
  - `health.ts` — Background probes; mark keys as `healthy`, `rate_limited`, `invalid`, or `error`.
- **`db/`** — Drizzle ORM schema + SQLite initialization.
- **`lib/crypto.ts`** — AES-256-GCM encryption for at-rest keys.
- **`middleware/errorHandler.ts`** — Centralized error response formatting.

### Client (`client/src/`)

React + Vite + Tailwind + shadcn/ui admin dashboard.

- **`pages/`** — Route components (Keys, Fallback, Analytics, Playground, Settings).
- **`components/`** — Shared UI (header, sidebar, key status indicators, charts).
- **`lib/`** — API client helpers, hooks.

### Shared (`shared/`)

TypeScript types: `ChatMessage`, `ChatCompletionResponse`, `Platform`, etc.

## Key Concepts

- **Provider adapters** — One per LLM platform. Must implement `BaseProvider.chatCompletion()` and `streamChatCompletion()`. Tool-calling format translation happens here (e.g., Gemini `functionDeclarations` ↔ OpenAI `tools`).
- **Router** — Selects model at request time. Picks first healthy key with headroom on all rate limits; falls over to next model on 429/5xx/timeout. Up to 20 retries.
- **Sticky sessions** — Concurrent requests with the same `freellmapi-…` token + model keep routing to the same provider for 30 minutes to avoid mid-conversation model switches.
- **Rate-limit ledger** — Per `(platform, model, key)` counters in memory, flushed to SQLite. Resets daily at UTC midnight. Router checks before picking a key.
- **Encryption** — API keys encrypted with AES-256-GCM on store, decrypted in-memory just before use. `ENCRYPTION_KEY` from `.env`.

## Common Commands

```bash
# Install dependencies (monorepo)
npm install

# Development (server on :3001, client/dashboard on :5173 with HMR)
npm run dev

# Run tests (vitest across server + client)
npm test

# Watch tests (useful for TDD)
npm run test:watch -w server
npm run test:watch -w client

# Production build
npm run build

# Run built app
npm run build && node server/dist/index.js
```

## Development Workflow

1. **Add a provider:** Copy `server/src/providers/openai-compat.ts` as template; override methods if needed. Add to `server/src/providers/index.ts`. Seed models in `server/src/db/index.ts`. Add test in `server/src/__tests__/providers/`.
2. **Modify router logic:** Edit `server/src/services/router.ts`. Test with `npm run test:watch -w server`.
3. **Update dashboard:** Edit `client/src/pages/` or `client/src/components/`. Vite HMR auto-refreshes on save.
4. **Add API route:** Create file in `server/src/routes/`, wire into `app.ts`.
5. **Database schema change:** Modify `server/src/db/index.ts`, test.

## Testing

- **Server tests:** `npm run test:watch -w server` — 75 tests covering providers, router, ratelimit, routes.
- **Client tests:** `npm run test:watch -w client`.
- **Integration tests:** `server/src/__tests__/integration/full-flow.test.ts`.

Include a test for any meaningful change (new provider, route, router logic).

## Environment

- **`.env`** — Required: `ENCRYPTION_KEY` (generated via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), optional `PORT` (default 3001).
- **Node.js:** 20+.

## Key Files for Reference

- **Router logic & fallover:** `server/src/services/router.ts`
- **Rate-limit tracking:** `server/src/services/ratelimit.ts`
- **Provider base class:** `server/src/providers/base.ts`
- **Tool-calling translation (Gemini):** `server/src/providers/google.ts`
- **Streaming SSE handling:** Look for `StreamingChatCompletion` in any provider.
- **Health checker:** `server/src/services/health.ts`
- **Dashboard state:** `client/src/lib/` API client hooks.

## Known Limitations & Gotchas

- **No embeddings, images, audio, or moderation endpoints.** Only `/v1/chat/completions` and `/v1/models`.
- **Vision/multimodal:** Content is text-only (no image attachments in messages).
- **Streaming:** SSE chunks must be valid JSON. Guard `JSON.parse` on Gemini streams (see PR #47).
- **Tool calling:** Gemini requires translation (`functionDeclarations` ↔ `tools`); other OpenAI-compat providers pass through. Multi-step flows work across all.
- **Free-tier churn:** Provider ToS and caps change frequently. Catalog re-seed scripts in `server/src/scripts/`.
- **Local-first design:** Single-user, no multi-tenant auth. Do not expose to the internet.
- **Terms of Service:** Review README's ToS table before deploying; most providers prohibit resale and third-party access.

## Debugging Tips

- **Route requests to a specific provider:** Temporarily modify `router.ts` to hard-code a model.
- **Inspect encrypted keys:** Keys are never logged; decrypt in-memory via `server/src/lib/crypto.ts`.
- **Streaming test:** Use `curl -N` or Python `stream=True` to validate SSE output.
- **Health check failures:** Check `server/src/services/health.ts` probes; may indicate invalid key or provider downtime.
- **Rate-limit ledger mismatch:** Ledger resets daily at UTC midnight; if you suspect stale state, restart the server.
