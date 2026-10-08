# Typhoon

Typhoon uses `https://api.opentyphoon.ai/v1` with bearer authentication for
OpenAI-compatible chat completions (including streaming) and audio transcription.
Create a key at [Typhoon Playground](https://playground.opentyphoon.ai), add it on
the Keys page, or import `TYPHOON_API_KEY` / `OPENTYPHOON_API_KEY`. Auth JSON
recognizes `typhoon`, `opentyphoon`, and `open-typhoon`.

The hosted API is an **ongoing free research showcase**, not a monthly credit
grant. It is rate limited, provided without a production SLA, and collects usage
data to improve its models and API. Do not send sensitive content without
reviewing its data-use terms. The provider recommends its paid infrastructure
partner for production-grade availability.

This integration covers chat and transcription only. Live-tested on 2026-10-07:

- `typhoon-v2.5-30b-a3b-instruct`: chat, SSE streaming, and tool calling.
- `typhoon-asr-realtime`: Thai speech transcription.
- `typhoon-isan-asr-realtime`: Thai / Isan speech transcription (smoke-tested
  with a standard Thai sample, not an Isan accuracy benchmark).

OCR is intentionally excluded. The older `typhoon-v2.1-12b-instruct` still
appears in documentation but returned `400: Model not found` during testing.

Model rows are published only through the signed hosted catalog. No migration,
bundled seed, or automatic model discovery bypasses the existing Premium-now /
Free-after-30-days gate. Older app versions must update to recognize Typhoon.

Key validation deliberately requests a nonexistent model against the chat
endpoint: the public `/models` endpoint cannot validate a key. Live controls
confirmed the exact `400 {"detail":"Model not found"}` response follows
successful authentication; invalid/missing credentials return 401/403. Other
responses, including rate limits and outages, remain inconclusive.

Transcription sends only multipart `file` and `model`, and consumes the upstream
JSON `text` field. The existing route renders JSON/plain text locally. Whisper
decoding options are not forwarded, and no native VTT/SRT or timestamps are
advertised. The existing global upload ceiling is unchanged.

Sources: [FAQ](https://docs.opentyphoon.ai/en/faq/),
[authentication](https://docs.opentyphoon.ai/en/authentication/),
[ASR](https://docs.opentyphoon.ai/en/asr/),
[rate limits](https://docs.opentyphoon.ai/en/rate-limits/).
