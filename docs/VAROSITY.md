# Varosity media provider

Add a Varosity API key from <https://varosity.ai/app/keys/api-keys> in the
dashboard's Keys page, or import `VAROSITY_API_KEY` from an environment file.
The native API base is `https://varosity.ai/api`;
this is not a chat-completions provider.

## Supported routes

| Modality | Tested model IDs | Adapter behavior |
| --- | --- | --- |
| Image | `flux-3-klein`, `flux-2-pro`, `qwen-image-3.0`, `gpt-image-2.5-flare` | One square image; Flare uses low quality. Native resolution varies by model (Qwen returned 2048px). Downloads are decoded and returned as PNG base64. |
| Speech | `openai-tts-1`, `elevenlabs-tts-v3`, `fal-kokoro`, `heygen-voice-turbo` | `/v1/audio/speech`; OpenAI voice names map to the provider default on non-OpenAI engines. Returns the actual MP3/WAV content type, since some engines ignore format hints. |
| Music | `lyria-2` | `/v1/audio/speech` with `input` as the music prompt and no voice. Requests a 30-second instrumental; native output can be slightly longer. Polls `/api/music/poll` without resubmitting. |
| Video | `grok-imagine-video` | `/v1/videos/generations`; one-second landscape text-to-video with audio, platform credits only. Polls `/api/v1/jobs/{jobId}`. |

All ten routes generated valid media on November 7, 2026. These are
provider-reported model identities, not independent attestation of weights.
`elevenlabs-music` failed upstream authorization and is not supported.

## Free eligibility and safety

The published free plan offers **10 credits ($0.10) per day** after email
confirmation, without a credit card. This is a **shared account allowance**,
not ten credits per model; daily grants expire at midnight UTC and do not roll
over. The separate $1.50 starter credit is not recurring, and starter grants
are limited. Successful tests used
the account's existing credits and demonstrate working API access, not
independent proof of future daily funding. Pricing and grant availability
can change.

The tested requests cost 1–3 cents/image, 1 cent/short speech sample,
10 cents/Lyria track, and 7 cents/one-second Grok clip. Longer speech uses
more credits. The adapter never buys credits, activates a subscription,
changes billing settings, or retries a held job as a new generation.

Credential checks use the authenticated, read-only credit-balance endpoint.
Scope errors, throttling and malformed responses remain inconclusive;
an empty balance does not invalidate the key. Generated assets use bounded,
credential-free downloads from allowlisted storage hosts, with redirects
blocked and private-address checks. Video polling honors client cancellation.

Models are delivered only by the signed hosted catalog. Adding this adapter
or a key does not seed models or change Premium-now / Free-after-30-days
availability. No catalog publication or release is performed by this PR.

Sources checked November 7, 2026:

- <https://varosity.ai/pricing>
- <https://varosity.ai/docs>
- <https://varosity.ai/api/openapi.json>
