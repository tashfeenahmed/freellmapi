# Moondream

Moondream Cloud provides a shared **$5/workspace monthly usage allowance** on
the Free plan. This is not $5 per model and not unlimited free inference.
Hosted usage beyond the allowance is metered. We route to its hosted API with
the user's own key; we do not host or redistribute model weights.

Sources checked September 22, 2026:

- [Pricing](https://moondream.ai/pricing)
- [OpenAI compatibility](https://docs.moondream.ai/openai/)

Add the key under **Moondream** on the Keys page, or import
`MOONDREAM_API_KEY=...`. The adapter calls
`https://api.moondream.ai/v1/chat/completions` with Bearer authentication.

Both `moondream3.1-9B-A2B` and `moondream3-preview` passed real image-question
and native text-streaming requests through this adapter, with matching returned
model IDs and usage. Model rows are published separately
in the signed Oracle catalog, not seeded in migrations. Existing Premium-now /
Free-after-30-days delivery remains unchanged.

## API differences

- Images must be base64 data URLs. Remote image URLs are rejected locally with
  a retryable provider error; the adapter does not fetch arbitrary URLs.
- Tool calling, tool history, stop sequences and structured output are not
  supported. Requests requiring them fail over rather than silently losing
  their meaning.
- `max_tokens` maps to `max_completion_tokens`, respecting the user's cap and
  Moondream's documented 4096-token output maximum (including reasoning).
- `reasoning_effort: none` disables reasoning; other effort levels enable it.
  The API exposes a boolean, not distinct effort levels.
- Native SSE is streamed, with optional usage and `reasoning` normalized to
  `reasoning_content`. Timeouts, disconnects and truncation use the shared
  provider infrastructure.
- Key checks send Bearer authentication to `/v1/models` without spending
  inference credits. Missing auth returns a public roster, but invalid Bearer
  credentials returned 401 in live tests; empty keys are rejected locally.
- No context-window or request-rate values are guessed. The public model list
  currently omits one working model and is not used to populate catalog rows.
