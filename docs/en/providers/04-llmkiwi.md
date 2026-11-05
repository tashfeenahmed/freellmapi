# LLM.kiwi

LLM.kiwi provides an ongoing free account tier for `auto` and `hrllm`.
Numeric request and token limits are unpublished; advanced direct models are
Pro features. Do not interpret an unspecified limit as unlimited usage.

Create an account at https://llm.kiwi and generate a key in the dashboard.
Select LLM.kiwi on the Keys page or import `LLMKIWI_API_KEY` from an env file.
The direct API base URL is `https://api.llm.kiwi/v1`, with Bearer authentication.

## Key health and quotas

Live controls on 2026-11-05 found that `/v1/models` returns 200 both anonymously
and with an invalid key. There is no documented free authenticated metadata
probe. This adapter disables credential validation: real inference establishes
key health, without periodic probes spending allowance or falsely declaring
a bad key healthy. Real chat requests with invalid credentials return 401.

One account quota pool is shared across model rows. No numeric quota is
invented and no full-roster model discovery or migration seeding is enabled.
Model rows remain controlled by the signed hosted catalog and its existing
age/tier gate. Adapter registration alone does not publish new model rows;
catalog authoring is also required. Use `auto` or the documented lowercase
`hrllm` as candidates and verify each against the provider before publication.

Direct smoke checks served `auto` in both non-streaming and streaming mode;
an invalid key returned 401. A request for `hrllm` returned a completion whose
model field was `auto`, so this test does not establish a pinned hrllm route.
Publish only the verified `auto` route until that identity mismatch is clarified.

## Primary sources

- https://llm.kiwi/docs — endpoints, authentication, model IDs, no-card signup.
- https://llm.kiwi/pricing — free `auto`/`hrllm` access versus Pro direct models.
- https://llm.kiwi/faq — public endpoint and authentication contract.
