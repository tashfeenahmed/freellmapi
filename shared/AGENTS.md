# shared — cross-package TypeScript types

**Relevant for:** type changes that affect both server and client  
**Depends on:** nothing (no dependencies, no imports from other packages)

---

## Files

```
shared/
├── types.ts     # 228 lines — Platform, Model, ApiKey, Chat*, AnalyticsSummary
├── package.json # "@freellmapi/shared" workspace package
└── tsconfig.json
```

---

## Key patterns

- **`Platform` union type**: string literal union of all supported providers (`'google' | 'groq' | 'cerebras' | …`). Adding a provider means adding it here first.
- **`ChatCompletionRequest` / `ChatCompletionResponse`**: mirror the OpenAI API shape (`model`, `messages`, `stream`, `tools`, `tool_choice`, `temperature`, etc.). This is the canonical shape that server adapters translate to/from.
- **`AnalyticsSummary`**: aggregated stats shape returned by the analytics endpoint. Used by both server (route) and client (dashboard).
- **No barrel file** — `types.ts` is the package entrypoint (`"main": "types.ts"`). Import from `@freellmapi/shared` directly.

---

## Conventions (this directory only)

- **Minimal dependencies** — zero runtime dependencies. Pure type definitions.
- **Server and client both depend on `@freellmapi/shared`** — types must be compatible with both Node (ESM) and the browser. No Node-specific APIs or browser-specific types here.
- **No semver within the monorepo** — types change at HEAD, consumed at HEAD.

---

## Pitfalls

- **Adding a new property to `ChatMessage`** affects server adapter parsing AND client display code — always check both consumers.
- **`Platform` union is used in switch/if chains** throughout `providers/` and `router.ts`. Adding a provider to the union without handling it everywhere causes TS errors — which is intentional (exhaustive check).
