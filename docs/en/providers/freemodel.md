# FreeModel

FreeModel is a personal bring-your-own-key chat provider. Add your own key in
**Keys → FreeModel**, or import `FREEMODEL_API_KEY` from an environment file.
Complete the provider's Telegram verification before making requests.

The provider advertises **1 million shared input/output tokens per month**, no
card required. This is one account allowance across all models, not a separate
allowance per model. FreeModel can use a funded wallet after the free allowance
is exhausted. **Keep the provider wallet unfunded for free-only use.** The app
does not add funds, upgrade plans, or verify the remaining monthly balance.
Reported rate-limit headers are not represented as a monthly balance.

Text chat and streaming were live-tested for the catalog routes on November 5,
2026. The adapter sends explicit streaming mode, rejects missing/substituted
model identities and empty completions, and preserves HTTP/backoff signals for
normal failover. Returned model identities are provider assertions, not
independent verification of model weights. FreeModel may raise an output-token
request below 2,048 to 2,048; a smaller requested value is not a provider-enforced
hard ceiling. Tools and vision are not advertised until separately tested.

The model list is public, so it cannot validate credentials. Keys are tested by
actual user requests, not automatic inference probes. Catalog models are not
seeded in the app: Premium receives signed live updates and Free receives them
through the unchanged 30-day catalog gate. Requires app v0.16.20 or later.

## Provider terms

FreeModel documents custom OpenAI-compatible clients and self-hosted tooling.
Its terms also restrict resale/redistribution and a directly competing gateway.
This integration uses each user's own key and includes no shared credentials;
it does not establish permission to operate a public or resold gateway. The
scope of the competing-gateway wording remains unresolved. Review the terms
and obtain provider approval where needed before shared or commercial use.

- [Free allowance](https://freemodel.in/free-ai-api)
- [Custom clients](https://freemodel.in/docs/coding-agents)
- [Terms](https://freemodel.in/terms)
