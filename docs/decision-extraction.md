# Keyless decisions and typed extraction

HAL-X and AI SENSE support `/v1/decisions` and `/v1/systemone`, not chat completions. Add the provider on the Keys page without a key to explicitly activate anonymous access. The usual key-pool cooldown, cancellation and failover apply. No credential is transmitted to either service. Catalog rows remain remotely managed and keep the existing Premium/Free release delay.

- HAL-X `THX-01`: ongoing keyless service, 200 decisions/minute/IP; each question counts as a decision. The adapter maps `instructions` to `question`.
- AI SENSE `clef`, `nimble`, `tev1`: 1,000 model requests/day/IP, shared between models, plus 60/minute and a 5,000/day service ceiling. The adapter explicitly selects the learned model, never the default rules engine, and returns `model_version` when available.

Provider contracts: [HAL-X](https://api.hal-x.ai/docs), [AI SENSE](https://www.aisense.no/free-public-api-decide-api-endpoint).

## Custom decision endpoints (#1777)

You can also point decisions at your own endpoint instead of a catalog provider. In the dashboard, open **Keys → Add key → Custom provider** and pick **Decision**; or register it with `POST /api/media/custom` and `modality: "decision"`, giving the endpoint's `baseUrl`, a `model` id, and an optional `apiKey` (omit it for a keyless local endpoint). It then appears on the Decision page and in `GET /v1/decisions/models`, and `POST /v1/decisions` runs it like any other decision model.

The endpoint speaks a proposed generic contract — one call per question, since a single decision value cannot answer several distinct questions:

```http
POST {base_url}/decide
Authorization: Bearer <key>
Content-Type: application/json

{"model": "my-decider", "prompt": "Which tier?\n\nState: fix: TypeError…", "choices": ["light", "code"], "context": "fix: TypeError…"}
```

```json
{"decision": "code", "confidence": 0.9, "reasoning": "It is a stack trace."}
```

`choices` are the question's options (`criteria` keys for a `choice` question, `["yes", "no"]` for `noul`, level indexes `"0"`, `"1"`, … for `score`); `decision` must be one of them, and `confidence` (0–1, defaults to 1 when omitted) is split across the options as the answer's probabilities. A decision outside the options, a missing decision, or a down endpoint is a 502 — the answer is never fabricated, and there is no fallback chain for decisions. This contract is a proposal, not a declared standard: the built-in providers share no wire shape, so if the maintainer settles a different one, this adapter follows it. Outbound URLs go through the same guard as every custom provider endpoint (#440), so cloud metadata addresses stay blocked.

## Clairic (Cloudflare Workers AI)

Clairic extracts fields rather than answering choice/noul/score questions. It is excluded from question auto-routing and the choice playground. Its tested text and number fields are available on the same authenticated endpoint:

```json
{
  "model": "@cf/cloudflare/clairic",
  "state": "Invoice INV-2291: four units at $250 each, plus $80 shipping.",
  "fields": {
    "invoice_number": {"type": "text"},
    "total": {"type": "number", "decimals": 2, "unit": "USD", "instructions": "Amount due including shipping"}
  }
}
```

Send `fields` or `questions`, never both. Answers preserve nullable `value`, confidence and other upstream metadata; `truncated` is surfaced. Cloudflare keys retain their existing `account_id:api_token` format and shared Workers AI allowance. No new allowance is granted per model. [Clairic contract](https://developers.cloudflare.com/workers-ai/models/clairic/).
