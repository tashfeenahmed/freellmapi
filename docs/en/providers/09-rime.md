# Rime speech

Add a Rime API key from [app.rime.ai](https://app.rime.ai) on the Keys page,
or import `RIME_API_KEY=...`. No project ID is required. Key validation stays
unknown until a real request succeeds: public voice lists cannot validate keys,
and health checks do not spend your speech allowance.

Rime Free includes **$50 shared usage per month**, without a card. It is not
$50 per model. See [current pricing](https://www.rime.ai/pricing).

Models arrive through the signed catalog: Premium gets the live feed; Free
gets each new row after the existing 30-day aging. Adding a key does not seed
models or bypass that rule. Rime cannot be used for chat or embeddings.

## Text to speech

`POST /v1/audio/speech`: select `coda` or `mistv3`, or use normal audio routing.
The tested adapter returns **WAV** (`response_format: "wav"`), at 24 kHz,
with up to 1,000 characters per request. Standard OpenAI voice names map to
`celeste` for Coda or `cove` for Mist v3. Native voice IDs are forwarded unchanged;
the adapter currently selects English. Unsupported formats fail explicitly.

## Transcription

`POST /v1/audio/transcriptions`: select `rime-stt` (our catalog slug; the native
API has no model selector), `auto`, or `whisper-1` for normal STT failover.
Upload a **16-bit PCM WAV**, mono or stereo, 8–48 kHz. The adapter downmixes
and resamples to native 16 kHz mono without requiring ffmpeg. Compressed MP3,
AAC, float WAV and raw PCM uploads are rejected before sending audio.

Languages: `en` (default) and `es`. JSON, text and verbose JSON use the existing
route formatter. Native subtitle timestamps, prompt and nonzero temperature
are not supported. A final `done` is required; partial text is never reported
as a successful transcription. Native limits are 16 MiB decoded audio and a
120-second session; this adapter bounds its session to 115 seconds.

Authentication goes only to the fixed Rime hosts over TLS. HTTP CONNECT proxies
are supported; a configured SOCKS proxy or Fetch Relay is explicitly refused
for STT rather than bypassed. TTS uses the ordinary outbound fetch transport.
Prism realtime speech-to-speech is not part of this adapter.
