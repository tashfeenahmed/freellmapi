# IteraCompute

IteraCompute uses `https://api.iteracompute.com/v1`, with Bearer API-key
authentication, on the OpenAI chat-completions shape. Add a key in the
dashboard or import `ITERACOMPUTE_API_KEY` from an environment file.

- Chat and SSE: `POST /chat/completions`, OpenAI request/response shape.
- Public model list, no key needed: `GET /models` returns every model with
  `is_free` and per-1M-token prices. Credentials are ignored on this endpoint
  (a bogus `Authorization` header still returns `200`, verified live
  2026-10-22), so it is NOT a credential probe.
- Key validation is off (`supportsKeyValidation === false`): the only
  authenticated endpoint is `/chat/completions`, and every request reserves
  against the monthly allowance before settling (free-tier terms). A health
  probe would burn user quota, so validity is proven by the first served
  request instead; a bogus key fails at request time with `401
  authentication_error invalid_api_key` (verified live 2026-10-22).

## Free eligibility, verified 2026-10-22

The free tier is one account-wide monthly TOKEN allowance: `qwen/qwen3.8-27b`
gets 30M tokens/month (input + output, reasoning included) at 160,000 TPM with
128K free context. No daily quota, no paid overage: once the allowance is spent
the API answers 429 until the reset at 00:00 UTC on the 1st (no rollover).
Free accounts may queue at peak; full or timed-out queues return 429 with
`Retry-After`, infrastructure failures 503. For plain answers without reasoning
text, send `"chat_template_kwargs": {"enable_thinking": false}`.

`moonshotai/kimi-k3-free` also shows `is_free: true` on the model list but
requires a $10 cumulative recharge first, so it does not meet the never-paid
rule from #853 and stays out of the catalog.

Model rows are published only through the signed Oracle catalog. No seeds,
model-discovery enrollment, or database migration bypasses the existing
Premium-now / Free-after-30-days release gate.

Sources:

- <https://iteracompute.com/free/>
- <https://iteracompute.com/free-tier-terms/>
- issue #1649
