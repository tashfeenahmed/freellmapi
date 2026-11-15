# Groq Orpheus speech

Use the existing Groq API key on the Keys page. The signed catalog supplies
`canopylabs/orpheus-v1-english` and `canopylabs/orpheus-arabic-saudi` as audio
models, not chat models. No bundled seeds or key-triggered discovery bypass
the existing Premium-now / Free-after-30-days catalog rule.

Call `POST /v1/audio/speech` with either model or normal audio routing.
The adapter returns validated PCM16 WAV bytes (`response_format: "wav"`).
Groq currently accepts at most 200 characters per request. Other formats
are rejected explicitly instead of returning a mislabeled file.

Omitting `voice`, or using a standard OpenAI voice name such as `alloy`,
selects `troy` for English and `fahad` for Saudi Arabic. Native voices are
supported for the corresponding model; see the [current Groq voice list](https://console.groq.com/docs/text-to-speech/orpheus).

Groq's renewable free allowance is shared, provider-imposed and daily—not
a monthly credit grant per model. Your organization administrator must first
accept each model's terms in the Groq console. A terms-required response
remains an upstream error; this adapter never accepts terms on your behalf.
HTTP failures retain their status and Retry-After backoff, and malformed
successful responses fail over through the existing media router.

See [Groq speech documentation](https://console.groq.com/docs/text-to-speech)
and [free-plan rate limits](https://console.groq.com/docs/rate-limits).
