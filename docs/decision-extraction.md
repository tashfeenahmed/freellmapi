# Keyless decisions and typed extraction

HAL-X and AI SENSE support `/v1/decisions` and `/v1/systemone`, not chat completions. Add the provider on the Keys page without a key to explicitly activate anonymous access. The usual key-pool cooldown, cancellation and failover apply. No credential is transmitted to either service. Catalog rows remain remotely managed and keep the existing Premium/Free release delay.

- HAL-X `THX-01`: ongoing keyless service, 200 decisions/minute/IP; each question counts as a decision. The adapter maps `instructions` to `question`.
- AI SENSE `clef`, `nimble`, `tev1`: 1,000 model requests/day/IP, shared between models, plus 60/minute and a 5,000/day service ceiling. The adapter explicitly selects the learned model, never the default rules engine, and returns `model_version` when available.

Provider contracts: [HAL-X](https://api.hal-x.ai/docs), [AI SENSE](https://www.aisense.no/free-public-api-decide-api-endpoint).

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
