# Typecast, Cartesia and SilvR AI

These providers use your own credentials, stored locally like other API keys.
Their tested model entries arrive from the signed hosted catalog, not bundled
seeds or model-list discovery. The existing Premium-now / Free-after-30-days
catalog policy is unchanged.

| Provider | Shared renewable Free allowance | Adapter |
| --- | --- | --- |
| Typecast | 15,000 credits/month; non-commercial output, attribution required | Native SSFM 3.1/3.0/2.1 speech |
| Cartesia | 20,000 credits/month across TTS/STT; commercial-use license requires a paid plan | Native Sonic 3.6/3.5/3 speech and Ink Whisper batch transcription |
| SilvR AI | $3.50/day across the account, no card | OpenAI-compatible chat with response identity checking |

Allowances are per account, not per model or API key. Adding multiple voices
does not create additional grants. Provider terms still apply to local use.

For speech, use `POST /v1/audio/speech` with `response_format: "wav"`.
The standard OpenAI voice names map to a tested native voice; a native Typecast
voice ID or Cartesia voice UUID can also be supplied. WAV audio is returned as
WAV, never relabeled as MP3. Cartesia speech defaults to English.

Ink Whisper uses `POST /v1/audio/transcriptions` with a file and model
`ink-whisper`. JSON, text and verbose JSON are supported; native subtitle
formats, prompts, nonzero temperature and realtime-only Ink-2 are not implemented.

No inference is run to validate a newly added key. The first real request
establishes key health. Native requests use fixed HTTPS endpoints, refuse
redirects, bound responses and preserve quota/authentication errors for the
existing router. The speech providers cannot enter the chat routing pool.

Verified November 14, 2026:

- [Typecast API pricing](https://typecast.ai/pricing/api/)
- [Typecast native API](https://typecast.ai/docs/api-reference/text-to-speech/text-to-speech)
- [Cartesia pricing](https://www.cartesia.ai/pricing)
- [Cartesia TTS](https://docs.cartesia.ai/api-reference/tts/bytes)
- [Cartesia batch STT](https://docs.cartesia.ai/api-reference/stt/transcribe)
- [SilvR free plan](https://silvrai.net/free)
