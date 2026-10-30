# GLIXEL: architecture, security decisions and limits

GLIXEL is the personal-assistant app served by FreeLLMAPI at `/glixel`. It
signs in with the dashboard session and never holds an API key. This page
describes increment 3: chat, Control Room and voice.

## Layout

| Piece | Where | What it does |
| --- | --- | --- |
| Chat endpoint | `server/src/routes/glixel.ts` (`POST /api/glixel/chat`) | Adds the GLIXEL persona as the only system message, accepts only user/assistant turns, and runs the shared `runInboundChat` pipeline, so free-only routing, fallback, logging and cancellation are the same as everywhere else. It streams the real route used. |
| Capabilities | `GET /api/glixel/capabilities` | Lists the AI paths and whether they work, plus the routing policy set by environment variables. Contains no key material. |
| AI paths | `server/src/glixel/providers.ts` | `freellmapi` is the default and the only working path. `claude` is declared but unavailable (see below). A request for an unavailable path gets `503 provider_unavailable`; it is never switched to another path. |
| Chat UI | `glixel/src/components/Chat.tsx`, `Markdown.tsx` | Streaming, Stop, Retry, copy response and copy code, history (shared with the Playground), and the real route under each reply. |
| Control Room | `glixel/src/components/ControlRoom.tsx` | Provider and gateway health, the AI path, routing policy and strategy, models ready for automatic routing, adding a provider key, and recent request outcomes. |
| Voice | `glixel/src/lib/voice.ts`, `lib/useVoice.ts`, `components/Voice.tsx` | Opt-in, browser-native speech input and read-aloud. |

## Security decisions

- **Writes are allow-listed by method and path** (`glixel/src/lib/session.ts`).
  These are the only writes, all to existing endpoints except the chat endpoint:
  - chat;
  - conversations (create, update, delete);
  - `POST /api/keys`;
  - `POST /api/health/check/:id`;
  - `PUT /api/fallback/routing`.

  Key reveal, export, import, delete, settings and the unified key are refused
  before the network. `glixel/src/security.test.ts` checks this in the source.
- **Keys go one way.**
  - The key field is cleared before the request is sent.
  - The masked key the server echoes back is not displayed.
  - Nothing is written to browser storage.
  - Keys never appear in URLs.
  - Disabling, deleting or revealing a key stays on the dashboard's Keys page.
- **Replies are untrusted Markdown.**
  - Rendering uses `react-markdown` (already a dashboard dependency), which builds React elements and never uses `innerHTML`.
  - Raw HTML is dropped.
  - Only `http(s)`, `mailto` and `#` links are kept.
  - Images are never loaded. They become plain links, because rendering an image URL from a model reply could leak the conversation to a third-party server.
- **Routing changes need a second step.**
  - The strategy change says it affects every client of the server.
  - It sends only `{ strategy }`; a server test checks that the other routing settings are kept.
  - Free-only routing and `FALLBACK_MAX_ATTEMPTS` are environment settings, so they are shown read-only.
- **The persona is enforced on the server** and is unchanged apart from asking
  for Markdown where it helps.

## Claude

Claude is not connected in this increment. The limitation, exactly:

1. FreeLLMAPI has no Anthropic provider adapter.
2. Claude.ai Pro/Max subscriptions do not include API access, as far as I know. The API is billed separately
   with an Anthropic API key from the Anthropic Console. Check Anthropic's
   current terms, since they may have changed.
3. Registering Anthropic as a `custom` OpenAI-compatible endpoint is **not** used
   as a workaround. Free-only routing blocks `custom` by default. Opting it in
   (`FREE_ONLY_ALLOW_PLATFORMS=custom`) would make a paid model eligible for
   **automatic** routing, so ordinary requests could be billed without asking.

What a real Claude path needs (a later increment, with your approval):

- An `anthropic` provider in the server catalog, marked paid and excluded from
  automatic routing, so it is reachable only when the request explicitly asks for it.
- The API key stored through the existing encrypted key storage (`POST /api/keys`), never in GLIXEL.
- `glixelProviders()` reporting `claude` as available once such a key exists,
  and the chat endpoint routing `provider: 'claude'` to that adapter only.
- A one-time "this path is billed" confirmation in the Control Room before
  Claude can be selected. No fallback from FreeLLMAPI to Claude, ever.

The selection architecture (request field, capabilities, UI, the
`provider_unavailable` error with a way back to FreeLLMAPI) is already in place.

## Voice

Voice uses the Web Speech API, with no added dependency and no paid service:

- **Input:** `SpeechRecognition` (`webkitSpeechRecognition` in Chrome).
  - One utterance per tap (`continuous = false`), with interim text shown.
  - **Done** and **Cancel** controls.
  - The text is added to the draft and never sent automatically.
  - A consent panel explains, before the first use in each page session, that
    Chrome's recognition uses Google's speech service, so audio may be sent to
    Google. GLIXEL itself never receives audio.
- **Output:** `speechSynthesis`, off by default.
  - It reads prose only: code blocks, tables, links and images are skipped.
  - Long replies are cut at a sentence, with "the rest is on screen".
  - **Stop speaking** cancels it.
- **Fallback:** the microphone button is hidden when the browser has no
  recognition, and typed chat always works.

Support is feature-detected. It was tested only with mocked speech APIs in
automated tests and in headless Chromium. It has **not** been verified on a real
Android device. Firefox for Android does not provide `SpeechRecognition`, as far
as I know. Samsung Internet support is unknown.

Microphone permission: the browser asks the first time. If it was denied,
re-enable it under the site's permissions in the browser settings
(`localhost:<port>` → Microphone). `http://localhost` counts as a secure
origin, so the microphone is allowed there. A LAN address over plain HTTP
would not be.

## Two servers on one database

If two FreeLLMAPI servers (for example the original one on 3001 and a GLIXEL test
build on 3002) use the same `freeapi.db`:

- Each server runs its own background jobs: health checks, catalog sync,
  cooldown and model probes, backup pump, backup schedule, custom and built-in
  model discovery. Both sets run, so the providers get twice the probe
  traffic, and backups are taken twice.
- Each runs migrations at start-up. Increments 1–3 add no migrations, so the
  schema stays compatible with main today. A future branch with migrations would
  upgrade the shared file for both.
- SQLite in WAL mode with a 5 s busy timeout keeps simultaneous writes safe, but
  in-memory router state (cooldowns, scores) is per process, so the two servers
  can disagree.

Recommended: run **one** server. The GLIXEL branch serves the dashboard at `/`
and GLIXEL at `/glixel`, so it can replace the original. To keep a second one
for testing, give it its own database with `FREEAPI_DB_PATH=/path/to/test.db`
and its own `ENCRYPTION_KEY`. Do not copy the real key or database.
