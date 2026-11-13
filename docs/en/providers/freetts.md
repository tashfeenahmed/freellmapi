# FreeTTS: local personal text-to-speech

Add your own key from [FreeTTS API Keys](https://freetts.org/dashboard?section=api-keys) on the Keys page, or import `FREETTS_API_KEY` from a local environment file. The key remains in your local encrypted database. No shared or hosted FreeTTS credential is bundled with FreeLLMAPI.

The signed catalog delivers one audio entry, `neural-tts`; this is FreeLLMAPI's logical engine ID, not a native FreeTTS model selector. FreeTTS selects neural voices through its `voice` parameter. Individual voices are not separate catalog models. The existing Premium-now/Free-after-30-days catalog rule is unchanged; importing a key never seeds an entry early.

Call the local `/v1/audio/speech` endpoint with `model: "neural-tts"`, plain-text `input`, `response_format: "mp3"`, and an optional native voice such as `en-US-JennyNeural` or `en-GB-SoniaNeural`. The default, and generic OpenAI voice names such as `alloy`, select Jenny. The adapter requests MP3 only, preserves the spoken FreeTTS watermark, and rejects substitutions or malformed audio. The current conservative provider request ceiling is 1,000 characters; conflicting higher numbers in the docs are not silently assumed.

FreeTTS advertises renewable monthly free characters without a card. Both authenticated generation responses on November 11, 2026 reported a 15,000-character account limit; the API FAQ also states 5,000/month, so check your own account rather than treating those as separate allowances. All voices and web/API usage share the allowance. Adding extra keys or choosing another voice does not multiply it.

**Free is personal/non-commercial and watermarked.** Use your own key for your own permitted local workloads. Local operation is not a waiver of the provider's terms: do not resell/proxy this account to unrelated users, strip the watermark, or present it as unrestricted commercial TTS. Review [pricing](https://freetts.org/pricing), [API documentation](https://freetts.org/developers), and [terms](https://freetts.org/terms).

There is no documented non-generating authenticated key check. A new key is unknown until its first successful speech request; the public voice list is not proof that a key works. The adapter creates a file through the native TTS API and fetches it only from FreeTTS's fixed HTTPS download path. It never follows a response-supplied URL or redirect with your credential. No chat, transcription, image or video support is claimed.
