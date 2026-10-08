# Plugsky and ElectronHub speech

Plugsky uses `https://plugsky.com/v1` with a bearer API key. Add the key on
Keys → Plugsky, import `PLUGSKY_API_KEY`, or use the `plugsky` auth.json entry.
Validation calls the authenticated, read-only `/plugsky/usage` endpoint, not
the public `/models` list. Transient failures remain inconclusive.

The permanent Free plan includes `plugsky-micro` and `plugsky-lite`, separately
from the wider seven-day trial. These are provider aliases with changeable
upstreams, not guarantees of particular model weights. Free chat is subject to
shared fair use; tools and paid/trial-only routes are not advertised as free.
See [Plugsky documentation](https://plugsky.com/docs).

ElectronHub speech uses `/v1/audio/speech` with the existing ElectronHub key.
The adapter supports MP3/WAV containers, defaults Gemini voices to `Kore` and
HUMAIN to `sara`, and preserves explicit provider voice names. Gemini may return
WAV when MP3 is requested; the returned MIME type follows the actual bytes.
HTTP-200 JSON/text errors and empty audio are rejected. Speech shares the
existing weekly free credit wallet, rather than getting a separate grant.
See [speech API](https://docs.electronhub.ai/api-reference/audio/speech) and
[credit policy](https://docs.electronhub.ai/billing/credits).

All model rows arrive through the signed catalog, with no database seeds or
automatic discovery. Premium/live and Free/30-day eligibility logic is unchanged.
Older installations must update the application to use these adapters.
