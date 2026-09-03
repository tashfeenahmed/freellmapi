# Supported platforms

The `Platform` union in [`shared/types.ts` (line 59)](../../shared/types.ts) is the single source of truth for platform identity; the runtime registry in [`server/src/providers/index.ts`](../../server/src/providers/index.ts) must match it. The union currently declares **42 members**:

- **40 built-in platforms** registered as adapters at startup,
- plus the **`custom`** placeholder (a real OpenAI-compatible adapter built per API key, since its base URL is user-supplied), giving **41 entries** in the registry map,
- plus **`sambanova`**, retained in the type union but no longer registered — it was dropped in V23 (June 2026) when its free tier was permanently retired (every chat call returns 402 "payment method required" once the one-time $5 trial credit lapses).

Of the 40 built-in platforms, **8 use dedicated native adapters** and **32 ride `OpenAICompatProvider`** against a provider-specific base URL. Three platforms are registered keyless (`kilo`, `ovh`, and `aihorde`, which auto-configures with its documented anonymous sentinel key). The public catalog headline in the README counts ~34 free providers / 474 model families / 635 free endpoints (~7.4 billion tokens/month of listed capacity) — fewer than the union because several registered gateways keep their free rosters in the hosted catalog rather than shipping them to every binary.

## Catalog

| Platform | Display name | Auth | Adapter | Notes |
| --- | --- | --- | --- | --- |
| `google` | Google Gemini | Keyed | Native (`GoogleProvider`) | Gemini wire format; 60s default timeout because Gemma reasoning variants take 20–60s on cold start. |
| `groq` | Groq | Keyed | OpenAI-compat | Standard compatible endpoint at `api.groq.com/openai/v1`. |
| `cerebras` | Cerebras | Keyed | OpenAI-compat | `api.cerebras.ai/v1`. |
| `sail` | Sail Research | Keyed (payment method required for recurring credit) | Native (`SailProvider`) | Stable `/v1/responses` integration submits background jobs and polls them to completion; flex-only models use the `flex` completion window. Sail grants $5 in monthly credits while a payment method is attached, then charges usage beyond that credit. |
| `bai` | B.AI | Keyed | OpenAI-compat | Gateway added in #918; only catalog row is a limited-time 0-credit promo, kept in the hosted catalog. |
| `anyapi` | AnyAPI | Keyed | OpenAI-compat | Free tier $0/no card/recurring, capped at 100K tokens/day over "free and basic" models; no RPM/RPD published (#772). Model ids arrive via catalog-sync, never seeded blind. |
| `nvidia` | NVIDIA NIM | Keyed | OpenAI-compat | `parallel_tool_calls` pinned false (#255); 180s timeout doubles as streaming first-byte grace (#584). |
| `mistral` | Mistral | Keyed | OpenAI-compat | `api.mistral.ai/v1`. |
| `sambanova` | SambaNova | Retired (V23) | Not registered | Free tier permanently gone; kept in the type union for historical key rows. |
| `openrouter` | OpenRouter | Keyed | OpenAI-compat | Sends `HTTP-Referer`/`X-Title` headers; `:free` model suffix marks zero-cost routes. |
| `github` | GitHub Models | Keyed | OpenAI-compat | Routes to `models.github.ai/inference`; catalog uses `<publisher>/<model>` ids. |
| `cohere` | Cohere | Keyed | Native (`CohereProvider`) | Uses Cohere's OpenAI-compatible endpoint. |
| `cloudflare` | Cloudflare Workers AI | Keyed (`account_id:token`) | Native (`CloudflareProvider`) | Compound credential format parsed by the adapter. |
| `zhipu` | Zhipu (Z.ai / bigmodel.cn) | Keyed | Native (`ZhipuProvider`) | Console autodetect: a rejected domestic key is re-probed against the global `api.z.ai` host; 60s timeout covers glm-4.7-flash hidden reasoning. |
| `ollama` | Ollama Cloud | Keyed | OpenAI-compat | 120s timeout for frontier reasoning models; reasoning returned in `message.reasoning`; catalog filtered to confirmed-free rows. |
| `kilo` | Kilo Gateway | Keyless | OpenAI-compat | Anonymous `:free` routes rate-limited 200 req/hr per IP; prompts/outputs logged for training; validation probes `/api/gateway/models` (#181). |
| `pollinations` | Pollinations | Keyed | Native (`PollinationsProvider`) | `GET /v1/models` answers 200 even for revoked keys, so validation probes the authenticated `/account/key` instead (#608). |
| `llm7` | LLM7.io | Keyed (anonymous works for basic models) | OpenAI-compat | 100 req/hr free tier. |
| `huggingface` | Hugging Face Router | Keyed | OpenAI-compat | `router.huggingface.co` meta-router (re-added V13); recurring $0.10/mo router credit on the free tier. |
| `opencode` | OpenCode Zen | Keyed | OpenAI-compat | Trial-only promotional free roster, docs-confirmed ids seeded via `migrateModelsV18`. |
| `ovh` | OVHcloud AI Endpoints | Keyless | OpenAI-compat | Anonymous tier: 2 req/min per IP per model (observed stricter); authenticated tier requires a Public Cloud project with payment method on file (`migrateModelsV26`). |
| `agnes` | Agnes AI | Keyed | OpenAI-compat | Proprietary models served at $0/token promotionally; ~30 concurrent requests before 429s; 60s timeout for reasoning TTFB. |
| `reka` | Reka | Keyed | OpenAI-compat | Free via recurring monthly credit grant (no card); balance dashboard-only. |
| `siliconflow` | SiliconFlow | Keyed | OpenAI-compat | Registered mainly for FREE generative-media models (FLUX.1-schnell image, CosyVoice2 TTS) routed via `services/media.ts`. |
| `routeway` | Routeway | Keyed | OpenAI-compat | Requires browser-style User-Agent (Cloudflare rejects others with error 1010); free pool observed stricter (~5 rpm) than the documented 20 rpm / 200 rpd. |
| `bazaarlink` | BazaarLink | Keyed | OpenAI-compat | Only the `auto:free` route is cataloged — direct model ids are paid (#385). |
| `ainative` | AINative Studio | Keyed | OpenAI-compat | Advertises recurring ~10M tokens/month free allocation; quota treated as unverified until confirmed by a real account. |
| `aion` | Aion Labs | Keyed | OpenAI-compat | No-card free key; availability catalog-managed behind the 30-day age gate. |
| `requesty` | Requesty | Keyed | OpenAI-compat | Router endpoint at `router.requesty.ai/v1`; free rows age into the monthly catalog. |
| `navy` | NavyAI | Keyed | OpenAI-compat | Free plan: 150K tokens/day and 20 RPM; live smoke tests require an explicit User-Agent header. |
| `nara` | NaraRouter | Keyed | OpenAI-compat | Free plan additionally requires Telegram channel/link verification; live-probed 2026-07-09. |
| `sealion` | SEA-LION (AI Singapore) | Keyed | OpenAI-compat | First-party API; Google sign-in, no card, no region wall; 10 RPM recurring free tier. |
| `orcarouter` | OrcaRouter | Keyed | OpenAI-compat | Recurring `$0` free aliases with intentionally unpublished limits (#896): 429 is a clean quota signal because free routes never fall back to paid models. |
| `unorouter` | UnoRouter | Keyed | OpenAI-compat | Free models carry `:free` suffix; per-minute rate limit (429 on cap). `GET /v1/models` public (200 no key) but 401 on wrong key; default key validation works. Catalog rows in hosted catalog (premium now, free after 30-day age gate). |
| `xkiro` | xKiro | Keyed | OpenAI-compat | Free plan: 5M tokens/day on free models (Mistral, MiniMax, DeepSeek families); paid models 403. `GET /v1/models` public (200 no key), so `validateUrl` points to `/v1/usage` which 401s on missing/invalid key. Accepts Bearer or `x-api-key`. Catalog rows in hosted catalog (premium now, free after 30-day age gate). |
| `modelscope` | ModelScope (Alibaba) | Keyed | Native (`ModelScopeProvider`) | Calls require binding to an Alibaba Cloud CHINA-site account with real-name verification; `GET /v1/models` accepts garbage tokens so validation uses a 1-token chat probe; retired models answer 429 "insufficient balance" (#581). |
| `qianfan` | Baidu Qianfan | Keyed | OpenAI-compat | ERNIE-Speed/Lite/Tiny free indefinitely via pay-as-you-go billing bounded by rate limits; Chinese real-name auth required (#936). |
| `volcengine` | Volcengine Ark (ByteDance) | Keyed | OpenAI-compat | Recurring daily per-model reward quota of 2M tokens/day/model for individual developers, on top of a one-time 500K new-user grant; real-name auth required (#936). |
| `longcat` | LongCat (Meituan) | Keyed | OpenAI-compat | Daily free quota; exception among the Chinese providers — email signup works from outside mainland China. Also speaks Anthropic wire at `/anthropic` (unused here) (#936). |
| `xfyun` | iFlytek Spark | Keyed | OpenAI-compat | Auth is the console APIPassword as a Bearer token; the Lite model is the documented free one; no published token/QPS ceiling (#936). |
| `aihorde` | AI Horde | Keyless (anonymous sentinel `0000000000`; registered key raises queue priority) | Native (`AIHordeProvider`) | Community volunteer workers via queue-based proxy: max_tokens >= 16, stop must be array, no tools, usage reported as kudos, 120s timeout, no upstream streaming (#345). |
| `custom` | Custom (OpenAI-compatible) | User-supplied base URL stored per `api_keys` row | OpenAI-compat built per key via `resolveProvider()` | Registered placeholder keeps `getProvider('custom')`/`hasProvider('custom')` well-behaved; 120s timeout for slow local runtimes (llama.cpp, vLLM, LM Studio) (#145). |

## Related history

- Moonshot direct integration and MiniMax direct were dropped in `migrateModelsV4` (paid-only / superseded by the OpenRouter route).
- Hugging Face was dropped in V4 ("tool-call format issues") and re-added in V13 through the Inference Providers meta-router.
- Chutes was evaluated for V11 and dropped: every model returned 402 requiring a non-zero balance, conflicting with the project's no-card criterion.
