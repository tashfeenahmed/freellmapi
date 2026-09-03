# Architecture & internals

[← Back to README](../README.md) · [Documentation index](README.md) · [Deep-dive domain](architecture/OVERVIEW.md)

FreeLLMAPI is a self-hosted OpenAI-compatible gateway that stacks the free tiers of ~34 providers behind a single `freellmapi-…` bearer token. An Express proxy exposes `/v1/chat/completions` (plus `/v1/responses`, `/v1/messages`, `/v1/completions`, `/v1/embeddings` and `/v1/models`) and, per request, the router selects the best healthy model that is under all of its rate limits, decrypts its upstream key in memory, and streams the response back.

Because no single free tier is generous enough to live on, the router treats the catalog as a pooled fallback chain: it scores live reliability, speed, capability and headroom via a Thompson-sampling bandit, enforces RPM/RPD/TPM/TPD and provider-wide caps with a persistent ledger, and fails over across up to 20 attempts within a wall-clock budget. When the top of the chain exhausts its daily caps the endpoint gracefully degrades to the next healthy tier and resets at UTC midnight.

See [OVERVIEW.md](architecture/OVERVIEW.md) for deep-dives.

- [How it works](#how-it-works)
- [Not yet supported](#not-yet-supported)
- [Limitations](#limitations)
- [Terms of Service review](#terms-of-service-review)

## How it works

![One request in, the best free model out — the fallback chain with live scores, cooldowns, and quota tracking](../repo-assets/router-flow.png)

```
┌──────────────────┐   Bearer freellmapi-…   ┌─────────────────────────┐
│  OpenAI SDK /    │ ──────────────────────▶ │  Express proxy (:3001)  │
│  curl / any      │ ◀────────────────────── │  /v1/chat/completions   │
│  OpenAI client   │      streamed tokens    └────────────┬────────────┘
└──────────────────┘                                      │
                                                          ▼
                             ┌────────────────────────────────────────────────┐
                             │  Router                                        │
                             │   1. Pick highest-priority model that          │
                             │      (a) has a healthy key and                 │
                             │      (b) is under all its rate limits.         │
                             │   2. Decrypt key, call provider SDK.           │
                             │   3. On 429/5xx → cooldown + retry next model. │
                             └────────────────────────────────────────────────┘
                                          │
   ┌──────────────┬────────────┬──────────┴─────────┬─────────────┬──────────┐
   ▼              ▼            ▼                    ▼             ▼          ▼
 Google         Groq        Cerebras           OpenRouter        HF       …29 more
```

- **Router** (`server/src/services/router.ts`) — picks a model per request.
- **Rate-limit ledger** (`server/src/services/ratelimit.ts`) — in-memory RPM/RPD/TPM/TPD counters backed by SQLite, with cooldowns on 429s.
- **Provider adapters** (`server/src/providers/*.ts`) — one file per provider, implementing the `Provider` base class: `chatCompletion()` and `streamChatCompletion()`.
- **Health service** (`server/src/services/health.ts`) — periodic probe keeps key status fresh.
- **Dashboard** (`client/`) — React + Vite + shadcn/ui admin surface.
- **Storage** — SQLite (`better-sqlite3`) with AES-256-GCM envelope encryption for keys.
- **Tool-call rescue** (`server/src/lib/tool-call-rescue.ts`) — models that emit tool calls as plain text instead of structured JSON are rescued into real `tool_calls` automatically, and tool requests only route to models that actually support them.
- **Key import & export** — bulk-import keys by pasting a `.env` file (with preview and per-key selection), export back out as JSON, `.env`, or CSV.

> Routing strategies, bandit scoring, quota and cooldown accounting, streaming, degraded-mode failover and the provider catalog are covered at implementation depth in the deep-dives — See [OVERVIEW.md](architecture/OVERVIEW.md) for deep-dives.

## Not yet supported

The scope is deliberately narrow. If a feature isn't in the README's feature list and isn't below, assume it isn't there yet.

- **Moderation** (`/v1/moderations`)
- **`n > 1`** (multiple completions per request)
- **Per-user billing / multi-tenant auth** — single-user by design

PRs that add any of these are very welcome. See [Contributing](../README.md#contributing).

## Limitations

Stacking free tiers has real trade-offs. Be honest with yourself about them:

- **Quota and availability are the ceiling, not model class.** The catalog does carry frontier-class rows — GPT-5.x, Grok 4.x, Kimi K3, DeepSeek V4 Pro, and Gemini 3.x all show up on somebody's free tier. What you don't get is *sustained* access to them: those are exactly the rows with the smallest daily allowances, the longest queues, and the highest chance of being pulled or paywalled at short notice. Budget for capacity and uptime, not for a capability limit.
- **Intelligence degrades as the day progresses.** Your top-ranked models (usually Gemini 3.6 Flash, DeepSeek V4, Kimi K2.6) have the lowest daily caps. Once they hit their limits, the router falls down your priority chain to smaller/weaker models. Expect the effective intelligence of the endpoint to drop in the late hours of each day — then reset at UTC midnight.
- **Latency is highly variable.** Cerebras and Groq are extremely fast; others are not. You get whichever one is available.
- **Free tiers can change without notice.** Providers regularly tighten, loosen, or remove free tiers. When that happens you'll see 429s or auth errors until the catalog update reaches you — live-feed installs get those fixes within days, free installs on the 30-day trail. Re-seed scripts live in `server/src/scripts/`.
- **No SLA, by definition.** If you need reliability, use a paid provider with a contract.
- **Local-first.** There's no multi-tenant auth. Run this for yourself; don't expose it to the internet.

## Terms of Service review

A self-hosted, single-user, personal-use setup was re-reviewed against each provider's ToS (May 2026). Summary:

| Provider | Verdict | Notes |
|---|---|---|
| Google Gemini | ⚠️ Caution | March 2026 ToS narrows scope to *"professional or business purposes, not for consumer use"* — a self-hosted developer proxy is still defensible, but the clause is new. |
| Groq | ✅ Likely OK | GroqCloud Services Agreement permits Customer Application integration. |
| Cerebras | ✅ Likely OK | Permitted; explicitly forbids selling/transferring API keys. |
| Mistral | ✅ Likely OK | APIs allowed for personal/internal business use. |
| OpenRouter | ✅ Likely OK | April 2026 ToS sharpens the no-resale / no-competing-service clause; private single-user proxy still fine. |
| Cloudflare Workers AI | ⚠️ Ambiguous | No anti-proxy clause; covered by general Self-Serve Subscription Agreement. |
| NVIDIA NIM | ⚠️ Caution | Trial ToS §1.2 / §1.4: *"evaluation only, not production."* Free access is a recurring 40 RPM rate limit (the 2025 credit system was discontinued), but the evaluation-only scope stands. |
| GitHub Models | ⚠️ Caution | Free tier explicitly scoped to *"experimentation"* and *"prototyping."* |
| Cohere | ❌ Avoid | Terms §14 still forbids *"personal, family or household purposes."* |
| Zhipu (open.bigmodel.cn) | ✅ Likely OK | Personal/non-commercial research carve-out still in the platform docs. |
| Z.ai (api.z.ai) | ⚠️ Caution | New row — Singapore entity (distinct from Zhipu CN). §III.3(l) anti-traffic-redirect clause could plausibly be read against a proxy; no explicit personal-use carve-out. |
| Ollama Cloud | ✅ Likely OK | New row — Free plan permits cloud-model access (1 concurrent, 5-hour session caps). No anti-proxy / anti-resale clauses found. *(Integration tracked in #14.)* |
| OVH AI Endpoints | ✅ Likely OK | New row (June 2026) — anonymous access is officially documented (2 req/min per IP per model). OVH reserves the right to introduce token/consumption caps. |
| AI Horde | ✅ Likely OK | New row (June 2026) — a free, community-powered commons run by the Haidra non-profit; anonymous use is officially supported (key `0000000000`, lowest queue priority). No anti-proxy / anti-resale clause. The OpenAI proxy is a pilot and may be restricted by usage. *(Integration #345.)* |

Rules of thumb that keep most providers happy: **one account per provider**, **no reselling**, **no sharing your endpoint with other humans**, **don't hammer a free tier as a paid production backend**. This is informational, not legal advice — read each provider's ToS and make your own call.

Removed since the April 2026 review: Moonshot and MiniMax direct integrations were dropped from the catalog (Moonshot — moved to paid only; MiniMax — superseded by the OpenRouter `minimax/minimax-m2.5:free` route).
