# APINex

APINex uses `https://api.apinex.bond/v1`, with Bearer API-key authentication.
Add a key in the dashboard or import `APINEX_API_KEY` from an environment file.

- Chat and SSE: `POST /chat/completions`, preserving the exact `free/` model ID.
- Decisions: `POST /decisions`, with `{model, state, questions}` and typed
  `choice`, `noul`, or `score` answers. JEV belongs in `decisionModels`, not chat.
- Key validation: read-only `GET /balance`. A $0 wallet is valid on Free;
  validation does not spend generation quota. Authentication failures are
  invalid; throttles, outages, and malformed responses remain inconclusive.
- Responses must identify the requested model. A substituted paid alias or
  malformed response is an error, never a silent success or paid retry.

## Free eligibility, verified 2026-10-18

Authenticated `GET /subscription` returned `mode: "free"`, `plan: null`, a
10,000,000-unit daily token allowance and the next midnight-UTC reset.
The public rate-limit endpoint reported 5 requests/minute on Free. The
allowance is shared across chat and decisions: current model multipliers
charge 2–4 units per input/output token. It is **not** 10M raw tokens per model,
a monthly cash credit, or a one-time signup balance.

Ten chat routes and one JEV decision route returned valid responses with a
$0 wallet, no subscription, and $0 billed. These tests verify working routes,
not independent attestation of the upstream model weights. Ten other routes
had `free/` names but `allowFree: false`: those are subscription-only and were
excluded. Eligibility must be checked using the provider's current public
model metadata, not the ID prefix alone.

Model rows are published only through the signed Oracle catalog. No seeds,
model-discovery enrollment, or database migration bypasses the existing
Premium-now / Free-after-30-days release gate. Existing installations need
application code containing this adapter before they can use these rows.

Sources:

- <https://apinex.bond/developers/models/chat>
- <https://apinex.bond/developers/models/decisions>
- <https://apinex.bond/developers/balance>
- <https://apinex.bond/api/public/subscriptions>
- <https://apinex.bond/api/public/rate-limits>
- <https://apinex.bond/api/public/models>
