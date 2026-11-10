# Additional provider integrations

This PR wires six independently useful providers into FreeLLMAPI's key and
routing infrastructure. It deliberately does not seed model IDs into a local
migration: the signed hosted catalog remains the authority for model exposure.

## LLM.kiwi

Free-account chat uses the OpenAI-compatible `https://api.llm.kiwi/v1` endpoint.
The `auto` route was live-checked for regular and streaming responses. Numeric
quotas are unpublished; scheduled key validation is disabled because the model
list is public and there is no documented no-spend authenticated probe. The
`hrllm` request returned a response identifying itself as `auto`, so do not
publish it as a pinned model until that behavior is resolved.

## TokenReply

Chat, JSON response formatting, and tool calls were live-checked on the
OpenAI-compatible `https://api.tokenreply.com/v1` endpoint. The public model
roster also contains trial and paid routes; only explicitly free models belong
in the hosted catalog. The observed account limit was three requests in a
minute during a short smoke check; treat this as an observation, not a published
provider-wide guarantee. Streaming is implemented by the common adapter but
remains under investigation after inconsistent responses in the live check.

## MNN

The OpenAI-compatible endpoint is `https://api.mnnai.ru/v1`. MNN documents a
$0 Free plan with one monthly internal credit and access to Free-tier models,
but its authenticated public roster does not prove which individual models
are free or whether inference stops before any paid balance can be charged. The
adapter is registered, while model rows must remain absent until free-plan
inference and the billing boundary are verified. Credential health polling is
disabled because `/v1/models` also returns 200 for invalid credentials.

## Fish Audio

The media adapter sends TTS to `https://api.fish.audio/v1/tts` using the
`s2.1-pro-free` model header and Bearer authentication. That free API offer is
announced through **2026-11-30**, is best-effort, and has no SLA; it is a
time-limited promotion rather than an evergreen grant. The live smoke check
returned MP3 audio. No chat or transcription route is claimed.

## Cartesia

The media adapter uses the Sonic TTS bytes endpoint and batch STT endpoint.
The official Free plan includes 20,000 monthly credits shared between TTS and
STT; Sonic costs one credit per character and Ink costs three credits per
second. The free plan is for evaluation and personal use; Cartesia lists its
commercial-use license under Pro. Live checks returned WAV audio from
`sonic-3.6` and the text `Test.` from `ink-whisper`. The adapters restrict
themselves to these tested routes and leave other models to catalog review.

## TinyFish

Search and Fetch are separate APIs. This change registers TinyFish for search
and exposes a guarded `POST /api/search/fetch` endpoint for 1–10 HTTP(S) URLs.
It authenticates with `X-API-Key`, returns TinyFish's per-URL result/error
shape, records usage, and uses the existing provider key budget and cooldown
plumbing. TinyFish currently documents Search at 30 requests/minute and 500/hour
and Fetch at 150 URLs/minute and 1,000/day; its pricing page says both remain
free at any wallet balance and do not draw wallet funds. Upstream limits and
eligibility may change, so model/catalog support remains host-managed.

## Primary references

- [LLM.kiwi docs](https://llm.kiwi/docs) and [pricing](https://llm.kiwi/pricing)
- [TokenReply docs](https://www.tokenreply.com/docs) and [free-model guide](https://www.tokenreply.com/guides/free-ai-api?client=app&format=openai&platform=janitorai)
- [MNN docs](https://mnnai.ru/docs) and [terms](https://mnnai.ru/terms-of-service)
- [Fish Audio TTS API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech) and [free API offer](https://fish.audio/blog/s2-1-pro-free-api/)
- [Cartesia TTS](https://docs.cartesia.ai/api-reference/tts/bytes), [STT](https://docs.cartesia.ai/api-reference/stt/transcribe), and [pricing](https://www.cartesia.ai/pricing)
- [TinyFish Search API](https://docs.tinyfish.ai/search-api/reference), [Fetch API](https://docs.tinyfish.ai/fetch-api/reference), and [pricing](https://www.tinyfish.ai/pricing)
