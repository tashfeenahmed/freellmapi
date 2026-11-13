# onomeo

onomeo uses `https://onomeo.com/v1`, with Bearer API-key authentication.
Add a key in the dashboard or import `ONOMEO_API_KEY` from an environment file.

- Chat and SSE: `POST /chat/completions`, OpenAI request/response shape.
- Key validation: read-only `GET /models`. Anonymous and invalid keys both get
  `401 {error: {code: "bad_key"}}` (verified live 2026-10-20), so it is a real
  credential probe; a valid key gets `{data: [...]}`.
- A `403` with `account_quota` or `network_quota`, and a `429` with `site_busy`
  or `too_fast`, are quota/throttle verdicts on a VALID key — validation treats
  them as inconclusive so the health pass can never auto-disable a good key
  whose 5-hour calls ran out.
- Other endpoints on the same key (not routed by this adapter): `/v1/messages`
  (paid models only), `/v1/responses`, `/v1/embeddings`, `/v1/rerank`,
  `/v1/audio/transcriptions`, `/v1/images/generations`. `GET /api/me` (outside
  `/v1`) reports balance and limits.

## Free eligibility, verified 2026-10-20

Free models are counted in CALLS, not tokens: 30 calls per account every
5 hours, of which the whole site shares 1,500 per window; a long request
counts as several calls (one per 50,000 counted characters). A payment grants
90 calls/5h for 35 days. Quota responses name themselves: `account_quota`
(403), `network_quota` (403), `site_busy` (429), `too_fast` (429).
`bad_key` (401) is the only authentication verdict. Answers to balance-less
accounts end with an "— via onomeo.com" signature line (tool-call,
structured-output and pure-JSON answers are exempt). The adapter strips it from
completions and streams (live 2026-10-21 it arrives as its own final delta), so
clients and agents never see it.

Model rows are published only through the signed Oracle catalog. No seeds,
model-discovery enrollment, or database migration bypasses the existing
Premium-now / Free-after-30-days release gate.

Sources:

- <https://onomeo.com/integrations>
- <https://onomeo.com/help>
- <https://onomeo.com/free-models>
