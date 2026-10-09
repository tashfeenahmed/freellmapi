**English** · [简体中文](../../zh-cn/providers/04-recurring-credit-gateways.md)

# ElectronHub and Experiential Labs

Both providers use bearer-authenticated Chat Completions at their `/v1` base
URLs. Model availability is managed in the signed Oracle catalog, not seeded
in application migrations. The existing Premium-immediate / Free-after-30-days
catalog policy is unchanged.

| Provider ID | Base URL | Key-validation endpoint | Free-plan funding |
| --- | --- | --- | --- |
| `electronhub` | `https://api.electronhub.ai/v1` | `GET /v1/user/me` | $0.25 shared weekly credits, not monthly; non-premium credit-backed routes only |
| `experiential` | `https://api.experientiallabs.ai/v1` | `GET /v1/models` | Published 500 shared monthly credits at $0.01 each ($5); confirm account eligibility/balance in its dashboard |

Checked 2026-09-06: 23 ElectronHub and 25 Experiential model IDs returned valid
text. ElectronHub's account API showed a Free subscription and spending from
weekly credits with no purchased-credit balance. Experiential authentication
and inference worked, but account balance is web-session-only; successful
inference alone does not establish whether an account used monthly, welcome,
or purchased credits. Neither provider is unlimited or grants credits per model.

ElectronHub's model list is public, so validation uses its authenticated account
endpoint. Its dedicated compatibility subclass rejects the observed proxy-error
banner embedded in HTTP-200 responses, including split SSE chunks. The other
seven tested ElectronHub candidates were excluded from catalog additions.

Experiential's compatibility subclass omits fixed-temperature and unsupported
top-p knobs on the specific Claude routes that reject them. This was caught
by a live adapter test using normal dashboard sampling settings, not merely a
minimal direct API request. Other models retain their supported settings.

Key imports accept `ELECTRONHUB_API_KEY`, `ELECTRON_HUB_API_KEY`,
`EXPERIENTIAL_API_KEY`, `EXPERIENTIALLABS_API_KEY`,
`EXPERIENTIAL_LABS_API_KEY`, and `EXPLABS_API_KEY`.

No provider billing settings are changed by the adapters. They observe shared
quota pools and provider response headers; they do not invent per-model credit
or token allowances. Set spend controls with the provider before enabling paid
top-ups or bring-your-own-provider-key routing.

Sources: [ElectronHub credits](https://docs.electronhub.ai/billing/credits),
[model access](https://docs.electronhub.ai/billing/model-access),
[account API](https://docs.electronhub.ai/api-reference/usage),
[Experiential pricing](https://www.experientiallabs.ai/pricing),
[billing](https://platform.experientiallabs.ai/docs/billing),
[API reference](https://platform.experientiallabs.ai/docs/reference).

## Inferbase and SimpleLLM

Added October 9, 2026. These adapters also receive model rows only through the
signed catalog; adding a key does not discover or seed the wider paid roster.

| Provider | API base | Read-only key validation | Shared free allowance |
| --- | --- | --- | --- |
| `inferbase` | `https://api.inferbase.ai/v1` | `GET https://api.inferbase.ai/api/v1/inference/credits` | 5,000 requests/month, also capped at 100 managed requests and $0.50 model usage/day; no card |
| `simplellm` | `https://api.simplellm.eu/v1` | `GET /v1/rate-limit` | Free-model hourly/daily requests and tokens, reported by the account API; not a monthly dollar grant |

Import `INFERBASE_API_KEY` or `SIMPLELLM_API_KEY`, or select the corresponding
provider on the Keys page. A zero purchased balance is valid. Authentication
failures are distinguished from temporary quota/server failures. Exact model
identity is checked; SimpleLLM's two tested free aliases may report their known
underlying names. Neither adapter enables billing, purchases credits or falls
back to a paid model automatically. Provider-side spending controls still apply.

Inferbase Free managed inference allows 8,192 input and 1,024 output tokens.
The adapter respects that upstream output ceiling; it does not impose a new
FreeLLMAPI request quota. SimpleLLM normalizes scalar stop strings to arrays.

ElectronHub embeddings use `/v1/embeddings` with float encoding and share the
same weekly wallet as chat. Returned model ID, dimensions, finite vector values
and batch indices are checked before accepting the vectors. No embedding model
rows are bundled into migrations.

Sources: [Inferbase pricing](https://inferbase.ai/pricing),
[SimpleLLM API](https://simplellm.eu/docs/),
[SimpleLLM limits](https://simplellm.eu/docs/reference/getRateLimit.html),
[ElectronHub embeddings](https://docs.electronhub.ai/api-reference/embeddings).
