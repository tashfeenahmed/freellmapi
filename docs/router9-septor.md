# Router9 and Septor Labs

Both are first-class OpenAI-compatible chat providers. Select them on the Keys
page or import `ROUTER9_API_KEY` / `SEPTOR_API_KEY`. This integration does not
seed model rows: the signed Oracle catalog controls availability and the
existing Premium-immediate / Free-after-30-days release gate.

## Free access (checked 2026-09-10)

- [Router9](https://www.router9.com/docs/token-plan/credits): 50,000 shared
  credits (about $5) each month on Free. Only provider-allowlisted models work;
  the tested route is `minimax/minimax-m3`. `auto` currently returns 404. Paid
  top-ups are optional and outside the free allowance.
- [Septor Labs](https://septorlabs.com/pricing): zero-price free models share
  50 requests / 500K tokens daily. Its separate $1 signup grant expires after
  90 days and is **not** a recurring monthly grant. Tested matching routes:
  `hermes-3-llama-3.1-405b-free`, `minimax-m2.5-free`, `qwen3-coder-free`, and
  `qwen3-next-80b-a3b-instruct-free`.

## Integration details

Router9's `/v1/models` is public even with an invalid bearer. Key validation
instead sends an incomplete, no-generation request to `/v1/chat/completions`.
A valid key yields `404 model_not_found` with account credit headers; an invalid
key yields 401. Validation consumes request quota, not inference credits.
Unknown verdicts (including generic proxy 404/429) remain inconclusive rather
than disabling a valid key. Streaming reuses the existing think-tag filter and
EOF handling; Router9 sends a finish reason and usage but no `[DONE]` sentinel.
Its live request-limit headers disagree with its documentation, so no fixed
request limit is invented. Actual credit headers feed the shared quota pool.

Septor authenticates `/v1/models`. Eleven other free IDs returned MiniMax M2.5
instead of the requested model during testing. Its adapter rejects mismatched
or missing response model IDs with a retryable 502, including before yielding
stream content, instead of silently reporting a substituted model. Explicit
`auto` routing may report a different model; it is not seeded or published by
this change. Model-ID matching is provider response evidence, not independent
verification of underlying weights.

No keys, paid plans, catalog snapshots, DB model migrations, or release-gate
changes are included in this integration.

The compiled adapters passed ten live inference checks (normal and streaming
for all five routes), plus valid/invalid key checks for both providers. Septor
reported zero charged cost for all eight adapter inference checks. All ten
answers completed with the expected text; these are smoke tests, not benchmarks.
