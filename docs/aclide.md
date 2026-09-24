# ACLIDE

Add an ACLIDE key in **Keys**, or import `ACLIDE_API_KEY` from an environment
file. Keys stay in the local encrypted key store, as with the other providers.

- API base: `https://aclide.com/v1`
- Key validation: authenticated `GET /models`
- Inference: `POST /responses` (ACLIDE does **not** expose Chat Completions)
- The adapter translates text/image input, function tools and tool results,
  structured output and token usage into the router's Chat Completions format.
- Streaming callers receive **buffered** role/content/tool/final chunks after
  the Responses request completes; upstream token-by-token streaming is not
  exposed by this adapter. Usage is included when requested.
- HTTP errors retain upstream status and Retry-After. Empty completed responses,
  nonterminal responses and unexpected model identities fail rather than being
  reported as successful calls. Client cancellation and a whole-request timeout
  also cover reading the response body.

Checked 2026-09-19: the Free plan advertises **€20 of shared monthly usage
credits**, renewed monthly without a payment card. These are ACLIDE's internal
usage credits, not cash or a separate grant for each model. Availability and
charges within that allowance depend on the model and account plan.

Model rows are delivered through the signed live catalog, not database seeds.
The existing Premium-immediate / Free-after-30-days release logic is unchanged.
Adding a key therefore does not unlock fresh model rows for Free installations.

Sources: [API documentation](https://aclide.com/en/documentation) and
[pricing](https://aclide.com/en/pricing).
