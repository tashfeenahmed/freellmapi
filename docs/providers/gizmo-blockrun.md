# Gizmo and BlockRun

Both providers use bearer API keys. Add a key in **Keys**, or import
`GIZMO_API_KEY=...` / `BLOCKRUN_API_KEY=...`. Model rows come exclusively from
the signed hosted catalog; no model seeds or automatic roster imports ship
with these adapters. Existing Premium-now / Free-after-30-days behavior is
unchanged.

## Gizmo

- Base URL: `https://api.gizmoplatforms.com/api/v1`
- Authentication check: `GET /models` (authenticated).
- Free plan: 1,000 zero-cost-model requests per calendar month, shared across
  account keys and models. Only tested `:free` routes qualify without a card.
- Text chat and SSE streaming are supported. Tool calling, image/audio
  messages, structured-output controls and unlisted sampling fields are not.
  Non-text/tool messages fail explicitly instead of being silently discarded.
- The documented default output allowance is 1,024 tokens; upstream maximum
  is 32,768. Existing operator/context caps still apply.

The six catalog candidates tested on 2026-10-03 are Qwen3.8 27B, Nemotron 3.5
Lightning, Nemotron 3 Ultra, Nemotron 3 Super, Laguna XS2.1 and Laguna S2.1.
Successful responses reported zero cost. Metered GLM and DeepSeek routes
required a payment method and are excluded.

[Official API documentation](https://gizmoplatforms.com/developers?tab=docs).

## BlockRun

- API-key base URL: `https://api.blockrun.ai/v1` (not the wallet/x402 host).
- Authentication check: `GET /account`, without generating tokens. A depleted
  prepaid balance does not itself invalidate a key or prevent $0 routes.
- Free routes are ongoing zero-priced, rate-limited models, not monthly cash
  credits. Paid models in the same roster are not automatically added.
- The provider can silently substitute a different free model with HTTP 200.
  Non-streaming responses and every streamed chunk must identify the requested
  model exactly; otherwise the adapter raises 502 before forwarding that data.

The four exact-model chat candidates tested on 2026-10-03 are Nemotron 3 Nano
Omni, Llama 3.2 11B Vision, Muse Glimmer 30B and Laguna XS2.1. Ledger charges
settled at $0. Tools/vision capabilities are not inferred from model names;
the initial catalog publishes conservatively tested text-chat routes.

[API-key documentation](https://blockrun.ai/docs/getting-started/enterprise-api)
and [free-model policy](https://blockrun.ai/free).
