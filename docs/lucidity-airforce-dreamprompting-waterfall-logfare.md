# Lucidity Composite, Api.Airforce, DreamPrompting, Waterfall and Logfare

All five are first-class OpenAI-compatible chat providers. Select them on the
Keys page or import `LUCIDITY_API_KEY` / `AIRFORCE_API_KEY` /
`DREAMPROMPTING_API_KEY` / `WATERFALL_API_KEY` / `LOGFARE_API_KEY`. This
integration does not seed model rows: the signed Oracle catalog controls
availability and the existing Premium-immediate / Free-after-30-days release
gate.

## Free access (checked 2026-09-15)

- [Lucidity Composite](https://composite.lucidity.sh): 250 free-model requests
  per day, shared across the account (`lucidity::daily-free`). Tested catalog
  routes: `lucidityai/synth-2.5-flash:free`, `lucidityai/synth-2.5-pro:free`,
  `inclusionai/ling-3.0-flash:free` and `mistralai/mistral-nemo:free`.
- [Api.Airforce](https://api.airforce): 1,000 requests per day and 1 request
  per minute per account (`airforce::daily-free`). The response echoed the
  requested id on all 20 tested routes.
- [DreamPrompting](https://dreamprompting.com): 500K tokens and 5,000 requests
  per rolling 24 hours (`dreamprompting::daily-free`).
- [Waterfall](https://getwaterfall.org): community free `-free` routes
  (`waterfall::community-free`). The response echoed the requested id exactly
  on every tested route.
- [Logfare](https://logfare.ai): fair-use free models (`logfare::fair-use`).
  `logfare/auto` echoes `logfare/auto` and `gemma-4-26b` echoes itself.

## Integration details

Every provider authenticates `GET /models` with the bearer key, so key
validation is a non-generating request: 401/403 is invalid, any other failure
stays inconclusive rather than disabling a valid key.

Each adapter rejects a mismatched or missing response model id with a
retryable 502, including before yielding stream content, instead of silently
reporting a substituted model. The accepted identities differ per gateway:

- Lucidity drops the `:free` suffix in its echo, and both `lucidityai/synth-*`
  routes legitimately report the gateway's own `synth-2.5-preview`. Its
  `open/*` routes were observed silently answering as `synth-2.5-preview`; the
  adapter rejects that, and no `open/*` route is published.
- Api.Airforce, Waterfall and Logfare must echo the requested id exactly.
- DreamPrompting is a fail-over router. Routes are addressed as
  `<upstream>/<upstream model id>` and the response reports the upstream id
  (`groq/openai/gpt-oss-20b` answers as `openai/gpt-oss-20b`,
  `codestral/codestral-latest` as `codestral-latest`, `chat/ch.at` as `ch.at`),
  with any `:free` suffix dropped. The `auto` route legitimately reports
  whichever upstream served the call, so its identity is not checked.

Api.Airforce's per-minute limit answers 429 with `Retry-After`; the adapter
surfaces that as the key cooldown and never retries into it. Waterfall's
upstream outages arrive as a 503 with a structured `detail` object
(`waterfall_transport_error` / `upstream_unavailable`) and surface as a 503
provider error. Logfare answers 403 for premium routes (surfaced as a 403
provider error), includes `reasoning_content` in responses and reports an extra
`neurons` usage field; both fields pass through untouched.

No quota headers are parsed for these providers: none was verified, so no
per-model budget is invented. Model-ID matching is provider response evidence,
not independent verification of underlying weights.

No keys, paid plans, catalog snapshots, DB model migrations, or release-gate
changes are included in this integration.
