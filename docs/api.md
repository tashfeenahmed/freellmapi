**English** · [简体中文](i18n/zh-CN/docs/api.md)

# API reference

[← Back to README](../README.md) · [Documentation index](README.md)

Any OpenAI-compatible client works (Anthropic / Claude clients too — see [Anthropic / Claude clients](#anthropic--claude-clients)). Base URL `http://localhost:3001/v1`, unified key from the dashboard's Keys page. An interactive OpenAPI viewer covering every proxy endpoint is served at `GET /v1/docs`; the spec itself lives at `GET /v1/openapi.json`.

- [Chat completions](#chat-completions)
- [Routing strategies (`auto:*`)](#routing-strategies-auto)
- [Streaming](#streaming)
- [Tool calling](#tool-calling)
- [Gemini Google Search grounding](#gemini-google-search-grounding)
- [Native Gemini API](#native-gemini-api)
- [Ollama emulation](#ollama-emulation)
- [Revocable URL tokens](#revocable-url-tokens)
- [Vision / image input](#vision--image-input)
- [Document attachments](#document-attachments)
- [Images, video & text-to-speech](#images-video--text-to-speech)
- [Fusion (multi-model synthesis)](#fusion-multi-model-synthesis)
- [Response headers](#response-headers)
- [Embeddings](#embeddings)
- [Anthropic / Claude clients](#anthropic--claude-clients)

## Chat completions

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

## Routing strategies (`auto:*`)

Plain `auto` follows your active fallback chain. Add a suffix to steer a single request instead — no dashboard changes needed:

- `auto:smart` — favor the highest-intelligence models
- `auto:fast` — favor measured speed (throughput and time-to-first-byte)
- `auto:cheap` — budget-leaning; currently the same blend as `balanced` (everything in the pool is already free)
- `auto:reliable` — favor recent success rate
- `auto:balanced` — the default blend (reliability first, speed and intelligence split the rest)

These rank **every enabled model**, ignoring your chain order. Common synonyms resolve too (`auto:fastest`, `auto:speed`, `auto:smartest`, `auto:cheapest`, `auto:budget`, …), and the whole model string is case-insensitive.

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto:fast",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

`auto:<profile-name>` routes through a named profile's chain instead of the active one, so different tools can use different chains through the same key:

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto:coding",
    "messages": [{"role": "user", "content": "Write a binary search in Rust."}]
  }'
```

An unknown profile name returns a clear `400` rather than silently falling back. Profiles are named fallback chains (see [Features](../README.md#features)) — create and switch them from the dashboard; whichever is active is what plain `auto` uses.

## Streaming

```python
stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Stream me a haiku about SQLite."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

## Tool calling

Pass OpenAI-style `tools` and `tool_choice`; the assistant response round-trips back through the proxy exactly like the OpenAI API. Multi-step flows (assistant `tool_calls` → `tool` role follow-up → final answer) work across every provider the router can reach.

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

# 1. Model asks for a tool call
first = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "What's the weather in Karachi?"}],
    tools=tools,
    tool_choice="required",
)
call = first.choices[0].message.tool_calls[0]

# 2. You execute the tool, feed the result back
final = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "What's the weather in Karachi?"},
        first.choices[0].message,
        {"role": "tool", "tool_call_id": call.id, "content": '{"temp_c": 32, "cond": "sunny"}'},
    ],
    tools=tools,
)
print(final.choices[0].message.content)
```

Works with `stream=True` as well — you'll get `delta.tool_calls` chunks followed by a `finish_reason: "tool_calls"` close. Under the hood, OpenAI-compatible providers (Groq, Cerebras, Mistral, OpenRouter, GitHub Models, HuggingFace, Cloudflare, Cohere compat) get the request passed through; Gemini requests get translated into Google's `functionDeclarations` / `functionResponse` shape and the response is translated back.

## Gemini Google Search grounding

Google's models can ground their answers in live Google Search results. Since the OpenAI wire format has no way to express that, request a tool named `google_search` and the Google provider translates it into Gemini's native grounding tool. It can be sent on its own or alongside your normal function tools.

```python
resp = client.chat.completions.create(
    model="gemini-2.5-flash",  # pin a Google model so the request routes there
    messages=[{"role": "user", "content": "Who won the F1 race this weekend?"}],
    tools=[{"type": "function", "function": {"name": "google_search", "parameters": {}}}],
)
print(resp.choices[0].message.content)
```

## Native Gemini API

Gemini SDKs and Gemini CLI can use the native `/v1beta` surface:

- `GET /v1beta/models`
- `GET /v1beta/models/{model}`
- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent` (`?alt=sse` for Gemini CLI)
- `POST /v1beta/models/{model}:countTokens`

```bash
curl "http://localhost:3001/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'
```

Gemini model names like `gemini-2.5-flash` resolve through the Gemini family map (Keys → Gemini model mapping) rather than the catalog directly, so they route to Auto or whichever catalog model each family is pinned to. Catalog ids work verbatim too.

`contents` text, inline data, function calls/responses, system instructions,
function declarations, structured JSON output, generation controls, and
thinking budgets translate into the same internal chat/fallback pipeline.
Bearer auth works too. Gemini's `?key=` query parameter is accepted only below
`/v1beta`; prefer a header because URL credentials leak into history and logs.

## Ollama emulation

The opt-in Ollama surface implements tags, chat, generate, show, version, embed,
and legacy embeddings under `/api/*`. Streaming is Ollama-compatible NDJSON.
It defaults to `off`; choose `open-loopback` or `key-required` on
**Keys → Agents**. Open-loopback checks the direct socket peer, so desktop LAN
access cannot silently turn it into an unauthenticated LAN endpoint.

The dashboard also owns `/api/embeddings`. A request with a valid dashboard
session continues to the dashboard handler; all other requests at that exact
path are treated as Ollama legacy embeddings and follow the emulation policy.

## Revocable URL tokens

Headerless clients can mirror models, chat completions, Responses, and
Ollama-style chat/tags under `/v1/t/{token}/…`. These tokens are random,
stored only as hashes, separately revocable, and are not the unified key.
Create/revoke them on **Keys → Agents**.

Treat them as sensitive anyway: URLs are routinely retained by shell history,
reverse proxies, browser history, and telemetry. Revocation is immediate.

## Vision / image input

Send images with the standard OpenAI `image_url` content blocks (base64 `data:` URLs or `http(s)` URLs). When a request contains an image, the router restricts itself to **vision-capable models** and ignores text-only ones. Vision models are tagged with a **Vision** badge on the Fallback Chain page; the current set includes Gemini (2.5 / 3.x), Llama 4 Scout/Maverick (Groq, NVIDIA), GLM-4.6V Flash (Z.ai), Nemotron Nano 12B VL (OpenRouter), and GitHub's GPT-4o / GPT-4.1.

```python
resp = client.chat.completions.create(
    model="auto",  # auto-routes to a vision model
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What's in this image?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}},
        ],
    }],
)
print(resp.choices[0].message.content)
```

If no vision-capable model is enabled in your Fallback Chain, an image request returns a clear `422` (`code: "no_vision_model"`) rather than silently dropping the image. (Image input on `/v1/responses` isn't supported yet — use `/v1/chat/completions`.)

## Document attachments

Anthropic's `document` content blocks are accepted on `/v1/messages` when their source is already text:

```json
{"type": "document", "title": "contract.txt",
 "source": {"type": "text", "media_type": "text/plain", "data": "PAYMENT TERMS: net 30."}}
```

`text` and `content` sources are inlined into the prompt, wrapped in a fence tagged with a hash of the document body so the model can tell quoted material from your instructions. The tag is derived from the content rather than randomized, so a repeated attachment keeps the prompt prefix stable and stays cacheable.

**Binary sources — `base64` (PDF, DOCX, XLSX…) and `url` — return a `400`.** No provider in the pool accepts them, and there is no local converter, so the honest answer is to refuse: forwarding the request would drop the attachment and produce a confident answer about a document the model never saw. The rejection happens before routing, so it spends no provider quota. Send the extracted text instead.

`url` sources are refused rather than fetched on your behalf; making the proxy retrieve arbitrary URLs would turn it into a request forwarder for whatever a client names.

## Images, video & text-to-speech

`POST /v1/images/generations`, `POST /v1/videos/generations`, and `POST /v1/audio/speech` route across the providers that serve media models. Images and speech also accept custom OpenAI-compatible media endpoints; video does not. Browse and toggle them on the dashboard's **Models → Image / Video / Audio** tabs.

Video generation accepts a JSON body with `prompt`, optional `model` (`auto` by default), and provider-dependent `duration`, `aspect_ratio`, `image`, `seed`, and `audio` options. It waits for queued providers to finish and returns the generated video as binary MP4 data:

```bash
curl http://localhost:3001/v1/videos/generations \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","prompt":"a sunrise over a quiet lake","duration":6}' \
  --output video.mp4
```

## Fusion (multi-model synthesis)

Request the virtual `fusion` model and the router fans your prompt out to a panel of diverse free models in parallel, then a judge model synthesizes one answer from the drafts. Panel, judge, and strategy are configurable on the dashboard's **Fusion** page or per request via the `fusion` field; each sub-call goes through normal routing, quotas, and analytics.

## Response headers

Every response carries an `X-Routed-Via: <platform>/<model>` header so you can see which provider actually served each call. If a request fell over between providers, you'll also see `X-Fallback-Attempts: N` and `X-Fallback-Trail`, which names each hop that failed and why:

```
X-Fallback-Attempts: 2
X-Fallback-Trail: groq/llama-3.3-70b key1=rate_limited; google/gemini-2.5-flash key2=timeout
```

`X-Fallback-Detail` adds what each of those hops **cost**, which is the part you cannot reconstruct from the trail — a request answered in 40s reads identically whether one provider stalled for 39 seconds or four failed fast:

```
X-Fallback-Detail: groq/llama-3.3-70b key1=rate_limited t=0+39000ms msg=Groq API error 429: rate limit; google/gemini-2.5-flash key2=timeout t=39000+12ms
```

`t=<start>+<duration>ms` is the offset from the start of the failover chain and how long that hop ran. `msg=` is the provider's error, redacted and truncated; it is last in each record, and any semicolon inside it becomes a comma so `; ` stays an unambiguous record separator.

The detail header is **off by default** — it puts hop timings and provider error text on the response. Turn it on with `FALLBACK_DETAIL_HEADER=1` or the `expose_fallback_detail_header` settings key, which takes precedence. Both headers list at most ten hops and then a `; +N more` marker.

Only hops that already **failed** can appear. The hop actually serving your request is recorded after its response finishes — after the JSON is sent, or after the stream closes — so its duration does not exist while the headers are still open. Use `X-Routed-Via` to see which provider that was.

HTTP headers only carry printable ASCII, so a model id with characters outside that range (a Chinese name from a relay catalog, for example) is percent-encoded in the header — run the value through `decodeURIComponent` (or `urllib.parse.unquote`) to read it back.

The opt-in response cache can be toggled per request with `X-FreeLLM-Cache: on|off` — an exact-match in-memory LRU for identical non-streaming requests (canonical SHA-256 keys over the full request, TTL and temperature gates, saved-token stats on the dashboard). Off by default; cache hits consume zero provider quota.

When [prompt compression](compression.md) is enabled, `X-FreeLLM-Compress: off|on|lossless|standard|aggressive` can disable or lower the configured mode for one request. It cannot raise the operator's configured mode. The response reports the effective mode and estimated savings, for example `X-FreeLLM-Compress: standard; saved~=1840`.

## Embeddings

`/v1/embeddings` is OpenAI-compatible, with one deliberate difference from chat routing: **failover never crosses models.** Vectors from different models live in incompatible spaces — silently switching models would corrupt any vector store built on top of the proxy. So embeddings route by **family** (one model identity + dimension), and failover only walks the providers serving that same family.

```python
resp = client.embeddings.create(
    model="auto",          # default family; or a family name like "bge-m3"
    input=["the quick brown fox", "pack my box with five dozen liquor jugs"],
)
print(len(resp.data), "vectors of", len(resp.data[0].embedding), "dims")
```

```bash
curl http://localhost:3001/v1/embeddings \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "input": "hello world"}'
```

`model` accepts `auto` (the configured default family), a family name, or a provider-specific model id (which resolves to its family). Available families:

| Family (`model`) | Dims | Providers (failover order) |
| --- | --- | --- |
| `gemini-embedding-001` *(default)* | 3072 | Google |
| `text-embedding-3-large` | 3072 | GitHub Models |
| `text-embedding-3-small` | 1536 | GitHub Models |
| `embed-v4.0` | 1536 | Cohere |
| `bge-m3` | 1024 | Cloudflare → Hugging Face |
| `qwen3-embedding-0.6b` | 1024 | Cloudflare |
| `nv-embedqa-e5-v5` | 1024 | NVIDIA |
| `llama-nemotron-embed-1b-v2` | 2048 | NVIDIA |
| `llama-nemotron-embed-vl-1b-v2` | 2048 | NVIDIA → OpenRouter |
| `embeddinggemma-300m` | 768 | Cloudflare |

The default family, per-provider toggles, and priorities live on the dashboard's **Models → Embeddings** page. Pick your family once and stick with it for a given vector store — that's the whole point of the family model.

## Anthropic / Claude clients

FreeLLMAPI also speaks Anthropic's Messages API, so anything built for Claude — including **Claude Code** and the official Anthropic SDKs — can run against your free pool. Point the client at your server's **origin** (Anthropic clients append `/v1/messages` themselves) and authenticate with your unified key. Both `x-api-key` and `Authorization: Bearer` are accepted.

```bash
curl http://localhost:3001/v1/messages \
  -H "x-api-key: freellmapi-your-unified-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

Claude model names map to your free pool on the **Keys → Anthropic** tab: each family (`default`, `opus`, `sonnet`, `haiku`) routes to `auto` (the router picks a free model) or a model you pin. `POST /v1/messages/count_tokens` and a content-negotiated `GET /v1/models` (Anthropic shape when `anthropic-version` is sent) are implemented too. Streaming, system prompts, tool use, and image input all translate across the same router as the OpenAI endpoints.

**Claude Code** — point it at your server and start it:

*On macOS / Linux (Bash):*
```bash
export ANTHROPIC_BASE_URL=http://localhost:3001
export ANTHROPIC_AUTH_TOKEN=freellmapi-your-unified-key   # NOT ANTHROPIC_API_KEY
claude
```

*On Windows (PowerShell):*
```powershell
$env:ANTHROPIC_BASE_URL="http://localhost:3001"
$env:ANTHROPIC_AUTH_TOKEN="freellmapi-your-unified-key"
claude
```

> Use `ANTHROPIC_AUTH_TOKEN` (sent as a Bearer token), **not** `ANTHROPIC_API_KEY` — Claude Code treats a set `ANTHROPIC_API_KEY` as a conflicting first-party credential and refuses to start.
