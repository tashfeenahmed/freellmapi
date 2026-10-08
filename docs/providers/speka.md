# Speka

Speka uses `https://speka.me/v1` with bearer authentication and OpenAI-compatible
chat completions (including streaming) and embeddings. Add a key in the Keys
page or import it as `SPEKA_API_KEY` in a key file; `speka` is also recognized
in imported auth JSON. This provider is not Speko.ai.

The Free plan advertises **$1 of model usage per month**, shared across models,
with no card required. It is not unlimited or a separate grant for each model.
The pricing page also describes paid overage: check the account's billing
settings rather than assuming all requests beyond the grant remain free.

Model rows are published through the signed hosted catalog only. Adding the
adapter or importing a key does not seed models or bypass the existing
Premium-now / Free-after-30-days release gate. Older app versions must update
to recognize the provider. Image generation is not enabled by this adapter.

Key validation uses a nonexistent model against the authenticated chat
endpoint. A controlled `400/model_not_found` confirms authentication without
running inference. `/models` is public and cannot validate a key. Authentication
errors are rejected; quota errors and outages remain inconclusive.

The embedding integration preserves the requested model and checks vector
dimensions through the existing embedding router. The separately tested
`nvidia/nemotron-3-embed-1b` route returned 2,048-dimensional vectors. Do not
assume interchangeability with another model merely because dimensions match.

Sources, checked 2026-09-24: [API reference](https://speka.me/docs),
[pricing](https://speka.me/pricing).
