# Free.ai

The Free.ai integration currently supports **Kokoro text-to-speech only** through
`POST /v1/audio/speech`. Model rows are distributed by the signed catalog; there
are no bundled seeds or changes to premium/free catalog timing.

Get a key at <https://free.ai/account/#api-keys>. The confirmed free account tier
has 30,000 shared internal tokens per day and 1,000 API requests per month, without
a card. These are account allowances, not a grant per model. Premium external
models require purchased tokens and are not included by this adapter.

Use model `kokoro`, voice `af_heart` and `response_format: "wav"`. If the format is
omitted, WAV is returned. Standard OpenAI voice names map to `af_heart`; native
voice names pass through. Other audio formats and untested models are rejected
before generation. The adapter calls Free.ai's native `/v1/tts/`, then retrieves
the WAV from its fixed output host without forwarding the credential or following
redirects. It checks the output bytes before returning them.

Free.ai can queue requests under load. This adapter reports those as a temporary
502 (`upstream_queued`), not successful audio. It does not follow
the browser-session queue URL or resubmit the generation automatically. Check
the provider's account history before retrying a queued request.

## Credential health

Live controls on 2026-10-11 found that the model roster, invalid-payload errors,
invalid-model errors **and even a successful Kokoro synthesis** returned the same
status for valid and bogus credentials. Those endpoints cannot prove that a key
is valid. Automatic health checks therefore skip credential validation entirely without
spending quota or recording a misleading validation error. Existing `unknown`
and `healthy` key states remain usable for inference; their status is not proof
that the credential is valid. The supplied key is still sent on actual
generation requests; this integration does not advertise anonymous access.

Kokoro generated valid WAV files during live testing. Two tested Qwen aliases
returned the same backend identity under conflicting advertised names; the other
chat, image, translation and transcription candidates failed or timed out. None
of those routes is included here.

References: <https://free.ai/api/> and <https://free.ai/developer/>. Some older
pricing text conflicts with these pages; the logged-in free account explicitly
confirmed the shared daily pool and monthly API cap, with zero purchased tokens.
