# Adding a new provider

A contributor walkthrough that mirrors how the existing 40 built-in platforms are wired. Read [`server/src/providers/index.ts`](../../server/src/providers/index.ts) alongside this guide — it is both the registry and the best documentation of per-platform judgment calls.

## 1. Declare the platform

Add the id to the `Platform` union in [`shared/types.ts`](../../shared/types.ts) (line 59) with a comment stating the free-tier facts you can defend: what is free, recurring or promotional, card or no card, and any signup walls. The union must stay in sync with the `PLATFORMS` allowlist in [`server/src/routes/keys.ts`](../../server/src/routes/keys.ts) — that zod enum gates which platforms users may register keys for.

## 2. Choose an adapter

- **OpenAI-compatible endpoint** → no new class. Register `OpenAICompatProvider` with the platform's base URL, as groq, cerebras, openrouter, and ~27 others do.
- **Wire-format divergence** → subclass `BaseProvider` in its own file and register it. Existing precedents:
  - `GoogleProvider` — native Gemini wire format;
  - `CohereProvider` / `CloudflareProvider` / `ZhipuProvider` — compatible chat routing plus key-shape or console-detection behavior;
  - `PollinationsProvider` / `ModelScopeProvider` — needed because their public model-list endpoints answer 200 even for bad keys, so validation needs a different probe;
  - `AIHordeProvider` — queue-based proxy diverging from the OpenAI contract (`max_tokens >= 16`, array-only `stop`, kudos usage, no tools).

Every adapter gets for free: timeout/stall wiring (`fetchWithTimeout`, first-byte budgeting #584), SSE reading with truncation detection, `<think>` extraction, and error construction via `providerHttpError`.

## 3. Register with the right options

In `index.ts`:

```ts
register(new OpenAICompatProvider({
  platform: 'yourplatform',
  name: 'Your Platform',
  baseUrl: 'https://api.example.com/v1',
}));
```

Options to consider, each used by a real registration:

| Option | When | Example |
| --- | --- | --- |
| `timeoutMs` | Cold starts or hidden reasoning exceed the 15s default; per-call overrides still win. | google 60s, nvidia 180s, ollama/custom 120s |
| `keyless: true` | The free tier works anonymously. The provider omits Authorization; the Keys page stores a sentinel row so routing treats the platform as configured. | kilo, ovh |
| `extraHeaders` | Provider requires specific headers. | openrouter referer/title; routeway/navy browser-style User-Agent behind Cloudflare |
| `forceSingleToolCall` | Upstream rejects parallel tool calls. | nvidia (#255) |
| `validateUrl` | Key validation should probe a different URL than `/v1/models`. | kilo probes `/api/gateway/models` |

Env-tunable timeouts come automatically via `PROVIDER_TIMEOUT_<PLATFORM>` (#547).

## 4. Get key validation right

`validateKey` returns a boolean or `{ valid: false, error }`. Use the inherited `validationResult(res)` helper to turn 401/403 into a diagnostic failure carrying the upstream reason. Two hard rules learned in production:

1. **Never trust a public models endpoint as proof of a valid key** (pollinations #608, modelscope): if `GET /v1/models` answers 200 unauthenticated, probe something authenticated instead.
2. **If validation consumes metered quota, cache it or find a free probe** — see [#882](02-quotas-and-cooldowns.md#health-checks-must-not-burn-metered-quota-882). Health runs every ~5 minutes against every stored key.

## 5. Seed the catalog deliberately

Model rows come from two places, and picking wrong leaks paid models to free users:

- **Versioned migrations** (`migrateModelsV<N>`) for docs-confirmed free rosters shipped to every binary (opencode V18, ovh V26).
- **Hosted catalog** via `services/catalog-sync.ts` (gated on `hasProvider`) when availability should be managed centrally — typically premium now, free after the 30-day age gate. Rows are never seeded from third-party lists without live verification: a bad model id is caught by health checks instead of shipped as default.

If the platform publishes no limits, set `null` rather than guessing; the unknown-limit cooldown path caps benches at 10 minutes precisely because guesses are not measurements.

## 6. Test it

Ship tests under [`server/src/__tests__/providers/`](../../server/src/__tests__/providers/) following the existing pattern (see `cn-providers.test.ts` for a batch of OpenAI-compat registrations): assert the outgoing request shape (URL, auth header placement, headers), response normalization, and any quirk you introduced. Run the full chain with `npm test` from the repo root — see [docs/testing](../testing/OVERVIEW.md).

## Checklist

- [ ] `Platform` union + `routes/keys.ts` `PLATFORMS` allowlist updated together
- [ ] Registration in `providers/index.ts` with defensible timeout/headers/keyless choices
- [ ] `validateKey` proven against real 401/403 bodies and public-endpoint gotchas
- [ ] Free-tier claims verified live (dates and observations in comments, like the rest of `index.ts`)
- [ ] Catalog seeding decision made explicitly (migration vs hosted catalog vs none)
- [ ] Provider tests added; root `npm test` green
