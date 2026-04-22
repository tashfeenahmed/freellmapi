<div align="center">

# FreeLLMAPI

**One OpenAI-compatible endpoint. Fourteen free LLM providers. ~1.3B+ tokens per month.**

Aggregate the free tiers from Google, Groq, Cerebras, SambaNova, NVIDIA, Mistral, OpenRouter, GitHub Models, Hugging Face, Cohere, Cloudflare, Zhipu, Moonshot, and MiniMax behind a single `/v1/chat/completions` endpoint. Keys are stored encrypted. A router picks the best available model for each request, falls over to the next provider when one is rate-limited, and tracks per-key usage so you stay under every free-tier cap.

[![CI](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml/badge.svg)](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

![Fallback chain with per-provider token budget](repo-assets/fallback-chain.png)

</div>

---

## Contents

- [Why this exists](#why-this-exists)
- [Supported providers](#supported-providers)
- [Features](#features)
- [Not yet supported](#not-yet-supported)
- [Quick start](#quick-start)
- [Using the API](#using-the-api)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Terms of Service review](#terms-of-service-review)
- [Disclaimer](#disclaimer)

## Why this exists

Every serious AI lab now offers a free tier — a few million tokens a month, a few thousand requests a day. On its own each tier is a toy. Stacked together, they add up to roughly **1.3 billion tokens per month** of working inference capacity, across dozens of models from small-and-fast to reasonably capable.

The problem is that stacking them by hand is painful: fourteen different SDKs, fourteen different rate limits, fourteen places a request can fail. FreeLLMAPI collapses that into one OpenAI-compatible endpoint. Point any OpenAI client library at your local server, and it routes transparently across whichever providers you've added keys for.

## Supported providers

<table>
<tr>
<td align="center" width="180"><a href="https://ai.google.dev"><b>Google</b><br/>Gemini 2.5 Pro / Flash</a></td>
<td align="center" width="180"><a href="https://groq.com"><b>Groq</b><br/>Llama 4, Qwen, Kimi</a></td>
<td align="center" width="180"><a href="https://cerebras.ai"><b>Cerebras</b><br/>Llama 3.3, Qwen</a></td>
<td align="center" width="180"><a href="https://cloud.sambanova.ai"><b>SambaNova</b><br/>Llama 3.3 70B</a></td>
</tr>
<tr>
<td align="center"><a href="https://build.nvidia.com"><b>NVIDIA</b><br/>NIM catalog</a></td>
<td align="center"><a href="https://mistral.ai"><b>Mistral</b><br/>La Plateforme</a></td>
<td align="center"><a href="https://openrouter.ai"><b>OpenRouter</b><br/>Free-tier models</a></td>
<td align="center"><a href="https://github.com/marketplace/models"><b>GitHub Models</b><br/>GPT-4o, Llama, Phi</a></td>
</tr>
<tr>
<td align="center"><a href="https://huggingface.co"><b>Hugging Face</b><br/>Inference Providers</a></td>
<td align="center"><a href="https://cohere.com"><b>Cohere</b><br/>Command R+ (trial)</a></td>
<td align="center"><a href="https://developers.cloudflare.com/workers-ai"><b>Cloudflare</b><br/>Workers AI</a></td>
<td align="center"><a href="https://bigmodel.cn"><b>Zhipu</b><br/>GLM-4 series</a></td>
</tr>
<tr>
<td align="center"><a href="https://platform.moonshot.cn"><b>Moonshot</b><br/>Kimi</a></td>
<td align="center"><a href="https://platform.minimax.io"><b>MiniMax</b><br/>abab / hailuo</a></td>
<td align="center" colspan="2"><i>Adding another? See <a href="#contributing">Contributing</a>.</i></td>
</tr>
</table>

## Features

- **OpenAI-compatible** — `POST /v1/chat/completions` and `GET /v1/models` work with the official OpenAI SDKs and any OpenAI-compatible client (LangChain, LlamaIndex, Continue, Hermes, etc.). Just change `base_url`.
- **Streaming and non-streaming** — Server-Sent Events for `stream: true`, JSON response otherwise. Every provider adapter implements both.
- **Tool calling** — OpenAI-style `tools` / `tool_choice` requests are passed through, and assistant `tool_calls` + `tool` role follow-up messages round-trip across providers.
- **Automatic fallover** — If the chosen provider returns a 429, 5xx, or times out, the router skips it, puts the key on a short cooldown, and retries on the next model in your fallback chain (up to 20 attempts).
- **Per-key rate tracking** — RPM, RPD, TPM, and TPD counters per `(platform, model, key)` so the router always picks a key that's under its caps.
- **Sticky sessions** — Multi-turn conversations keep talking to the same model for 30 minutes to avoid the hallucination spike that comes from mid-conversation model switches.
- **Encrypted key storage** — API keys are encrypted with AES-256-GCM before hitting SQLite; decryption happens in-memory just before a request.
- **Unified API key** — Clients authenticate to your proxy with a single `freellmapi-…` bearer token. You never expose upstream provider keys to your apps.
- **Health checks** — Periodic probes mark keys as `healthy`, `rate_limited`, `invalid`, or `error` so the router skips dead ones automatically.
- **Admin dashboard** — React + Vite UI to manage keys, reorder the fallback chain, inspect analytics, and run prompts in a playground. Dark mode included.
- **Analytics** — Per-request logging with latency, token counts, success rate, and per-provider breakdowns.
- **Deploys to a Raspberry Pi** — Runs happily on a Pi 4 under PM2 behind nginx. ~40 MB RSS at idle.

## Not yet supported

The scope is deliberately narrow. If a feature isn't on this list and isn't below, assume it isn't there yet.

- **Embeddings** (`/v1/embeddings`)
- **Image generation** (`/v1/images/*`)
- **Audio / speech** (`/v1/audio/*`)
- **Vision / multimodal inputs** — message content is text-only
- **Legacy completions** (`/v1/completions`) — only the chat endpoint is implemented
- **Moderation** (`/v1/moderations`)
- **`n > 1`** (multiple completions per request)
- **Per-user billing / multi-tenant auth** — single-user by design

PRs that add any of these are very welcome. See [Contributing](#contributing).

## Quick start

**Prerequisites:** Node.js 20+, npm.

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install

# Generate an encryption key for at-rest key storage
cp .env.example .env
echo "ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env

# Start server + dashboard together
npm run dev
```

Open http://localhost:5173 (the Vite dev UI), add your provider keys on the **Keys** page, reorder the **Fallback Chain** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI SDK at.

For a production build:

```bash
npm run build
node server/dist/index.js     # server + dashboard both served on :3001
```

## Using the API

Any OpenAI-compatible client works. Examples:

**Python**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="freellmapi-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # let the router pick; or specify e.g. "gemini-2.5-flash"
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
print(resp.choices[0].message.content)
print("Routed via:", resp.headers.get("x-routed-via"))
```

**curl**

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

**Streaming**

```python
stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Stream me a haiku about SQLite."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

Every response carries an `X-Routed-Via: <platform>/<model>` header so you can see which provider actually served each call. If a request fell over between providers, you'll also see `X-Fallback-Attempts: N`.

## Screenshots

### Keys

Manage provider credentials and grab the unified API key your apps connect with. Each key shows a status dot and when it was last health-checked.

![Keys page](repo-assets/keys.png)

### Playground

Send a chat completion through the router and see which provider served it, with the model ID and latency printed right on the message.

![Playground page](repo-assets/playground.png)

### Analytics

Request volume, success rate, tokens in and out, average latency, and per-provider breakdowns over 24h / 7d / 30d windows.

![Analytics page](repo-assets/analytics.png)

## How it works

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
 Google         Groq        Cerebras           OpenRouter        HF       …10 more
```

- **Router** (`server/src/services/router.ts`) — picks a model per request.
- **Rate-limit ledger** (`server/src/services/ratelimit.ts`) — in-memory RPM/RPD/TPM/TPD counters backed by SQLite, with cooldowns on 429s.
- **Provider adapters** (`server/src/providers/*.ts`) — one file per provider, implementing the `Provider` base class: `chatCompletion()` and `streamChatCompletion()`.
- **Health service** (`server/src/services/health.ts`) — periodic probe keeps key status fresh.
- **Dashboard** (`client/`) — React + Vite + shadcn/ui admin surface.
- **Storage** — SQLite (`better-sqlite3`) with AES-256-GCM envelope encryption for keys.

## Limitations

Stacking free tiers has real trade-offs. Be honest with yourself about them:

- **No frontier models.** The free-tier catalog tops out around Llama 3.3 70B, GLM-4.5, Qwen 3 Coder, and Gemini 2.5 Pro. You will not get GPT-5 or Claude Opus class reasoning through this. For hard problems, pay for a real API.
- **Intelligence degrades as the day progresses.** Your top-ranked models (usually Gemini 2.5 Pro, GPT-4o via GitHub Models) have the lowest daily caps. Once they hit their limits, the router falls down your priority chain to smaller/weaker models. Expect the effective intelligence of the endpoint to drop in the late hours of each day — then reset at UTC midnight.
- **Latency is highly variable.** Cerebras and Groq are extremely fast; others are not. You get whichever one is available.
- **Free tiers can change without notice.** Providers regularly tighten, loosen, or remove free tiers. When that happens you'll see 429s or auth errors until you update the catalog. Re-seed scripts live in `server/src/scripts/`.
- **No SLA, by definition.** If you need reliability, use a paid provider with a contract.
- **Local-first.** There's no multi-tenant auth. Run this for yourself; don't expose it to the internet.

## Contributing

Contributors very welcome! Good first PRs:

- **Add a provider** — copy `server/src/providers/openai-compat.ts` as a template, wire it into `server/src/providers/index.ts`, seed its models in `server/src/db/index.ts`, add a test in `server/src/__tests__/providers/`.
- **Add an endpoint** — embeddings, images, moderations. The provider base class can grow new methods; adapters declare which they support.
- **Improve the router** — cost-aware routing (cheapest-healthy-fastest tradeoffs), better latency-weighted priority, regional pinning.
- **Dashboard polish** — charts on the Analytics page, key rotation UX, batch import of keys from `.env`.
- **Docs** — more examples, client library snippets for Go/Rust/etc., a deployment recipe for Docker or Fly.

**Development loop:**

```bash
npm install
npm run dev      # server on :3001, dashboard on :5173, both with HMR
npm test         # vitest — 69 tests across providers, routes, router, ratelimit
```

PRs should include a test, keep the existing test suite green, and match the `.editorconfig` / tsconfig defaults already in the repo. Issues and discussions are open.

## Terms of Service review

A self-hosted, single-user, personal-use setup was reviewed against each provider's ToS (April 2026). Summary:

| Provider | Verdict | Notes |
|---|---|---|
| Google Gemini | ✅ Likely OK | No adverse clause; proxy for personal use not prohibited. |
| Groq | ✅ Likely OK | Explicitly permits integrating into a "Customer Application." |
| Cerebras | ✅ Likely OK | Permitted; don't resell keys. |
| Mistral | ✅ Likely OK | APIs allowed for personal/internal business use. |
| OpenRouter | ✅ Likely OK | Private-use only; don't expose the proxy publicly. |
| Hugging Face | ✅ Likely OK | BYO-key proxying is the documented pattern. |
| Zhipu | ✅ Likely OK | Explicit "personal, non-commercial research" carve-out. |
| Moonshot / Kimi | ✅ Likely OK | Competitive-products clause is broad but not aimed at single-user proxies. |
| SambaNova | ⚠️ Ambiguous | Public terms are silent on APIs. |
| MiniMax | ⚠️ Ambiguous | Public terms silent. |
| Cloudflare Workers AI | ⚠️ Ambiguous | No adverse clause found. |
| NVIDIA NIM | ⚠️ Caution | Free tier is "evaluation only, not production." |
| GitHub Models | ⚠️ Caution | Free tier scoped to "experimentation." |
| Cohere | ❌ Avoid | Trial ToS §14 explicitly forbids personal/household use. |

Rules of thumb that keep most providers happy: **one account per provider**, **no reselling**, **no sharing your endpoint with other humans**, **don't hammer a free tier as a paid production backend**. This is informational, not legal advice — read each provider's ToS and make your own call.

## Disclaimer

**This project is for personal experimentation and learning, not production.** Free tiers exist so developers can prototype against them; they aren't a stable, supported inference substrate and shouldn't be treated as one. If you build something real on top of FreeLLMAPI, swap in a paid API before you ship. Your relationship with each upstream provider is governed by the terms you accepted when you created your account — those terms still apply when the traffic is proxied through this project, and you're responsible for complying with them.

## License

[MIT](./LICENSE)
