# FreeLLMAPI — Integration Architecture

**Generated:** 2026-05-31

## Part Communication Map

```
┌─────────────┐          HTTP REST          ┌─────────────┐
│   Client    │ ───────────────────────────▶ │   Server    │
│  (React)    │   /api/keys                  │  (Express)  │
│             │   /api/models                │             │
│             │   /api/fallback              │             │
│             │   /api/analytics             │             │
│             │   /api/health                │             │
│             │   /api/settings              │             │
│             │   /v1/chat/completions       │             │
└─────────────┘                              └──────┬──────┘
                                                    │
                                                    │ HTTPS
                                                    ▼
                                      ┌────────────────────────────┐
                                      │  17 Upstream Providers     │
                                      │  (Google, Groq, Cerebras,  │
                                      │   SambaNova, NVIDIA, etc.) │
                                      └────────────────────────────┘
```

## Integration Points

### Client → Server

| From | To | Type | Protocol | Details |
|------|----|------|----------|---------|
| `client/src/lib/api.ts` | `server/src/routes/keys.ts` | REST | HTTP GET/POST/DELETE/PATCH | Key CRUD |
| `client/src/lib/api.ts` | `server/src/routes/models.ts` | REST | HTTP GET/PATCH | Model catalog |
| `client/src/lib/api.ts` | `server/src/routes/fallback.ts` | REST | HTTP GET/PUT/PATCH | Fallback chain |
| `client/src/lib/api.ts` | `server/src/routes/analytics.ts` | REST | HTTP GET | Analytics queries |
| `client/src/lib/api.ts` | `server/src/routes/health.ts` | REST | HTTP GET/POST | Health checks |
| `client/src/lib/api.ts` | `server/src/routes/settings.ts` | REST | HTTP GET/POST | Settings |
| `client/src/pages/PlaygroundPage.tsx` | `server/src/routes/proxy.ts` | REST + SSE | HTTP POST | Chat completions |

### Server → Upstream Providers

| From | To | Type | Protocol | Details |
|------|----|------|----------|---------|
| `server/src/providers/google.ts` | Google Gemini API | REST | HTTPS POST | Native format translation |
| `server/src/providers/openai-compat.ts` | 13 providers | REST | HTTPS POST | OpenAI-compatible passthrough |
| `server/src/providers/cohere.ts` | Cohere API | REST | HTTPS POST | v2/chat endpoint |
| `server/src/providers/cloudflare.ts` | Cloudflare Workers AI | REST | HTTPS POST | account_id:token auth |
| `server/src/providers/memos.ts` | MemOS API | REST | HTTPS POST | Custom protocol |

### Shared Types Contract

`shared/types.ts` provides the type-safe contract between client and server:

- `Platform` — union of 17 provider identifiers
- `Model`, `ApiKey` — database entity types
- `ChatCompletionRequest`, `ChatCompletionResponse` — OpenAI-compatible wire formats
- `AnalyticsSummary`, `PlatformStats`, `TimelinePoint` — analytics response types
- `RateLimitStatus` — rate limit state type

### Static Asset Serving

In production, Express serves the client build from `client/dist/`:

```typescript
// server/src/app.ts
app.use(express.static('../../client/dist'));
// SPA fallback for client-side routing
app.use((req, res) => res.sendFile('index.html'));
```

This means in production, client and server share the same origin (port 3001).

## Data Flow

### Chat Completion Request

```
1. Client PlaygroundPage → POST /v1/chat/completions
2. proxy.ts validates model → sticky session check
3. router.ts selects model from fallback chain
4.   → checks rate limits (ratelimit.ts)
5.   → decrypts API key (crypto.ts)
6. Provider adapter calls upstream API
7.   → on success: record request/tokens, return response
8.   → on 429: penalize model, cooldown key, retry next model
9.   → on error: retry up to 3 times across fallback chain
10. Response returned to client (JSON or SSE stream)
```

### Key Addition Flow

```
1. Client KeysPage → POST /api/keys { platform, key, label }
2. keys.ts validates with Zod schema
3. crypto.ts encrypts key with AES-256-GCM
4. SQLite INSERT into api_keys
5. Health checker validates key against provider on next cycle
```
