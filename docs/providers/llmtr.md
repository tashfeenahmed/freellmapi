# LLMTR

LLMTR exposes an OpenAI-compatible API at `https://llmtr.com/v1`. Create an account,
verify email, and create a dashboard API key. Add it under **Keys → LLMTR**, or
import `LLMTR_API_KEY` from an environment file. Never commit the key.

Selected routes are zero-priced with daily or rolling quotas, not monthly cash
credits. The [migration guide](https://llmtr.com/docs/en/migration/openai-openrouter/)
documents free requests at zero balance. Account caps can vary; this integration
does not invent numeric quotas or make the whole provider roster free.
New accounts have a reduced free allowance that increases automatically once
the account is 24 hours old. A quota response observed during testing confirmed
this waiting option; no top-up is required. A streaming smoke test reached that
quota, so only non-streaming inference was live-verified in this publication.

## Catalog and release timing

Model rows are supplied only by the hosted signed catalog. There are no bundled
seeds or automatic discovery of LLMTR's paid models. Existing Premium-immediate
and Free-after-30-days release logic is unchanged.
Older app versions need an update to recognize the new provider.

Five routes returned matching model IDs and valid text completions on 2026-09-29:

- `qwen/qwen3.8-27b-free`
- `nvidia/nemotron-3-ultra-550b-a55b`
- `nvidia/nemotron-3-super-120b-a12b`
- `motif/motif-3`
- `inclusionai/ling-3.0-flash-fin`

These checks are not independent proof of the underlying model weights. Tools,
vision and context limits require separate verification before catalog flags are
enabled. Motif's [quota](https://llmtr.com/docs/en/gateway/motif-3/) replenishes each
request after 24 hours. Expiring promotions and EVREN BYOK routes are excluded.

## Authentication and errors

The public `/v1/models` endpoint cannot validate a key. Dashboard `/api/usage`
rejected API-key authentication during testing. Instead, key validation submits
a deliberately nonexistent model without generating tokens. Live valid/invalid
controls returned `404/model_not_found` and `401/auth_error`, respectively.
Other errors remain inconclusive; quota exhaustion does not mark a key invalid.

Chat and streaming use the shared OpenAI-compatible transport, preserve usage and
backoff, and reject mismatched response model IDs rather than silently accepting
substitutions. No automatic paid fallback is introduced by this adapter.
