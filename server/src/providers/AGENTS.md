# providers — LLM adapter layer

**Relevant for:** adding or modifying provider integrations  
**Depends on:** `shared/types.ts` (Platform type), `db/` (model seed data)

---

## Files

```
providers/
├── base.ts           # Abstract BaseProvider (241 lines) — 3 abstract methods + shared helpers
├── index.ts          # Registry — Map<Platform, BaseProvider>, exported getProvider()
├── openai-compat.ts  # Generic adapter for OpenAI-compatible REST APIs
├── google.ts         # Gemini-specific (functionDeclarations translation)
├── cohere.ts         # Cohere-specific (custom format)
└── cloudflare.ts     # Cloudflare-specific (custom format)
```

Total: 6 files, ~1,131 lines. 14+ provider instances registered via `index.ts`.

---

## Key patterns

- **BaseProvider** (abstract): `chatCompletion(req)`, `streamChatCompletion(req)`, `validateKey(key)` — every adapter implements these 3.
- **OpenAI-compatible**: instantiated via `new OpenAICompatProvider(config)` where config = `{ platform, name, baseUrl, modelMap }`. Covers Groq, Cerebras, SambaNova, NVIDIA, Mistral, OpenRouter, GitHub Models, Zhipu, Kilo, Pollinations, LLM7, HuggingFace.
- **Custom adapters** (Google, Cohere, Cloudflare): extend `BaseProvider` directly and translate between the OpenAI chat-completion shape and the provider's native format.
- **`makeId()`**: utility in `base.ts` that strips the `/`-suffixed version from model IDs returned by upstream APIs so the router sees clean names.
- **`fetchWithTimeout()`**: shared fetch wrapper with configurable timeout, used by all adapters.

---

## Conventions (this directory only)

- **Every provider MUST be registered** in `index.ts` or `getProvider()` won't find it. No auto-discovery.
- **OpenAI-compat is the default path** — only write a custom adapter when the provider's API differs significantly (e.g. Gemini's `functionDeclarations`, Cohere's streaming format).
- **Model ID convention**: `platform/model-name` (e.g. `groq/llama-3.3-70b`). The `modelMap` in the config maps user-facing names to provider-specific model strings.

---

## Pitfalls

- **Missing model seeds** — adding a provider adapter isn't enough. Models must also be seeded in `db/index.ts` or the router won't see them.
- **Streaming format varies** — each provider sends SSE differently. `openai-compat.ts` assumes standard `data: {"choices":[...]}` chunks. Custom adapters handle their own SSE parsing.
- **`validateKey` is called on health probes** — if your adapter's validation endpoint is slow or flaky, marks the key as unhealthy unnecessarily.
