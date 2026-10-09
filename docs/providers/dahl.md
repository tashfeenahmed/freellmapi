# Gonka DAHL

Gonka DAHL uses `https://inference.dahl.global/v1` with bearer authentication
for OpenAI-compatible chat completions, including streaming and tool calling.
It serves open-weight models on the Gonka decentralized GPU network. Add a key
on the Keys page or import it as `DAHL_API_KEY` in a key file; `dahl` is also
recognized in imported auth JSON.

A new account gets a **one-time 100 million token welcome grant**. Sign-up asks
for a username only (no email, no card) and shows a fingerprint that acts as
the password and cannot be recovered. The grant lands in the account **pool**,
not on a key: new keys start at 0 tokens and return
`402 available tokens exhausted` until tokens are allocated to them on the
[account page](https://inference.dahl.global/account). After the grant, usage
is prepaid at about $0.03 per 1M tokens; nothing renews monthly.

DAHL publishes no fixed per-key RPM or RPD. When a model is at capacity it
returns `429` with `error.code: model_concurrency` and a `Retry-After` header,
and signed-in and paid accounts are admitted first. The adapter keeps that
status and the `Retry-After` delay for the router.

Model rows are published through the signed hosted catalog only. Adding the
adapter or importing a key does not seed models or bypass the existing
Premium-now / Free-after-30-days release gate. Older app versions must update
to recognize the provider. Embeddings are not served, and native `/v1/messages`
returns 405.

Key validation calls `GET https://inference.dahl.global/tokens/current`, which
is authenticated and returns the key's own balance without running inference.
`/v1/models` is public and cannot validate a key. Live controls returned 401
`invalid_api_key` for a missing or wrong key and `200 {"available_tokens": N}`
for a real one; other responses stay inconclusive. A key with 0 tokens is
still valid. The same endpoint feeds the quota probe, so the dashboard shows
the key's remaining tokens. The account pool is not visible to a key.

Live-tested on 2026-10-08 with `MiniMaxAI/MiniMax-M2.7` (180K context):
chat, SSE streaming ending in `data: [DONE]` with a usage chunk, and tool
calling. MiniMax returns its reasoning as a leading `<think>` block in the
content; the existing think-tag handling moves it to `reasoning_content`.
`/v1/models` also lists `deepseek-ai/DeepSeek-V4-Flash-0731` and
`zai-org/GLM-5.3-Flash` (400K context each). Their output was not reliable in
the same tests, so check them before adding catalog rows.

Sources, checked 2026-10-08: [authentication](https://inference.dahl.global/docs/authentication/),
[tokens and keys](https://inference.dahl.global/docs/tokens/),
[API and errors](https://inference.dahl.global/docs/api/),
[models](https://inference.dahl.global/docs/models/),
[pricing](https://inference.dahl.global/pricing/).
