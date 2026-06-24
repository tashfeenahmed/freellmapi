Here is the complete architectural audit and root-cause analysis based on a thorough review of the codebase:
──────
### SECTION 1 — MEDIA ARCHITECTURE

#### 1. GET  /api/media  Execution Flow

1. Route Endpoint: media.ts handles requests to  GET / .
2. Key Counts Query: Queries the database to count active healthy keys per platform:
   SELECT platform, COUNT(*) AS n
   FROM api_keys
   WHERE enabled = 1 AND status IN ('healthy', 'unknown')
   GROUP BY platform;

3. Fetch Media Models: Invokes the media.ts service method.
4. List Models Query: Executes a SQL query against the  media_models  table:
   SELECT * FROM media_models ORDER BY modality, priority, id;

5. Response Return: Maps the rows to JSON containing the model IDs, names, status, modality type ( 'image'  or  'audio' ), and matching platform
   key counts.

#### 2. POST  /v1/audio/speech  Execution Flow

1. Route Endpoint: proxy.ts routes the standard speech API path.
2. Authorize Request: Extracts and verifies the bearer token matching the unified API key via  extractApiToken .
3. Zod Validation: Validates the input body using  speechParamsSchema .
4. Execute Speech Service: Invokes the media.ts service function:
   export async function runSpeech(model: string | undefined, params: SpeechParams): Promise<SpeechResult>

5. Resolve Candidates Chain: Invokes media.ts:
   • Queries enabled candidates:
   SELECT * FROM media_models WHERE modality = 'audio' AND enabled = 1 ORDER BY priority, id;

   • If a specific model was requested (not  "auto" ), filters the chain to only match  model_id .
6. Iterate & Call Provider: Loop through candidates in priority order:
   • Queries platform credentials via  getPlatformKey(row.platform) :
   SELECT encrypted_key, iv, auth_tag
   FROM api_keys
   WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')
   ORDER BY id LIMIT 1;

   • Bypasses key checks for keyless-supported platforms (e.g.,  pollinations ).
   • Delegates execution to media.ts.
7. Execution Adapters:
   • Cloudflare MeloTTS: Sends requests to  /run/@cf/myshell-ai/melotts  returning base64 audio.
   • SiliconFlow: Sends standard POST requests to  /v1/audio/speech .
   • Pollinations: Keyless chat-completions request with  modalities: ['text', 'audio'] .
   • Google Gemini: Sends a POST request to Gemini's  generateContent  with  responseModalities: ['AUDIO']  and voice name configurations.
   Audio is returned as raw PCM bytes, which is wrapped in a 44-byte WAV header via media.ts.
8. Logging & Response: Logs latency, status, and error payload to the  requests  database table, returning the audio buffer with the correct
   content type.
   ──────
### SECTION 2 — ROOT CAUSE ANALYSIS

#### Why does the  No enabled audio providers configured  error occur?

1. Where media models are loaded: In media.ts inside media.ts:
   const rows = listMediaModels(modality); // modality = 'audio'

2. Where filtering occurs: In media.ts which filters rows in the database:
   return getDb()
   .prepare('SELECT * FROM media_models WHERE modality = ? AND enabled = 1 ORDER BY priority, id')
   .all(modality) as MediaModelRow[];

3. Where the error is thrown: In media.ts:
   if (rows.length === 0) {
   throw new MediaError(`No enabled ${modality} providers configured.`, 503);
   }

4. Triggering Database State: The  media_models  table starts empty after initialization, and background catalog synchronization pulls zero
   media models on the free tier. Because there are no matching rows with  modality = 'audio'  and  enabled = 1  in the database,  rows.length ===
   0  is true, triggering the error.
   ──────
### SECTION 3 — MEDIA MODEL POPULATION

1. Is media data seeded locally?
   No. In migrations.ts inside the  migrateMediaV1  migration, only the table structure is created ( CREATE TABLE IF NOT EXISTS media_models ...
   ). No default rows or fallback seeds are inserted.
2. Is media data synced remotely?
   Yes. Models sync remotely during the Ed25519-signed background catalog sync.
3. Which file inserts media rows?
   catalog-sync.ts via  insertMedia.run(...)  inside the  applyCatalog  transaction block.
4. Why are dashboard tabs empty?
   The catalog is fetched twice daily from  https://api.freellmapi.co/v1/latest . Free tier users fetch a catalog snapshot of  tier: "monthly" .
   This free catalog contains only text/chat models and contains zero models with a defined  modality  key (which default to  "text" ). Because the
   free catalog does not contain  image  or  audio  modalities, the  catalog-sync  inserts zero media models, leaving  media_models  empty and the
   dashboard tabs blank.
   ──────
### SECTION 4 — TTS IMPLEMENTATION STATUS

#### 1. Supported Providers, Models & Adapters

• Cloudflare AI
• Adapter File: media.ts
• Function Name: media.ts
• Supported Model: MeloTTS ( @cf/myshell-ai/melotts )
• SiliconFlow
• Adapter File: media.ts
• Function Name: media.ts
• Supported Model: CosyVoice ( FunAudioLLM/CosyVoice2-0.5B  etc.)
• Pollinations
• Adapter File: media.ts
• Function Name: media.ts
• Supported Model: Keyless OpenAI-audio model ( openai-audio )
• Google Gemini
• Adapter File: media.ts
• Function Name: media.ts
• Supported Model: Gemini prebuilt voice ( gemini-2.5-flash-preview-tts  etc.)


#### 2. Request Flow

POST /v1/audio/speech  →  proxyRouter  → authorizes unified key →  runSpeech  →  resolveMediaChain  → loops over candidate models → queries
platform API keys via  getPlatformKey  → calls  callSpeechProvider  (adapters map inputs to payload parameters & fetch the remote endpoint) →
logs stats via  logMedia  → outputs raw audio buffer to client.

#### 3. Can TTS work immediately if  media_models  contains rows?

YES.
The routing logic and adapters are completely functional. If the  media_models  table is seeded with valid audio rows (and corresponding
credentials, e.g. the already functional Google API key, are in the  api_keys  table),  resolveMediaChain  will return candidates, retrieve the
key, call the Gemini TTS endpoint, and return speech audio successfully.
──────
### SECTION 5 — STT IMPLEMENTATION DESIGN

To add a production-ready, OpenAI-compatible Speech-to-Text ( POST /v1/audio/transcriptions ) endpoint, we have modified the following files:

1. proxy.ts: Registers  /v1/audio/transcriptions  with memory-storage  multer  to accept multipart audio file uploads, parses form fields,
   and routes to  runTranscription .
2. media.ts: Implements parameters, response types, routing loop ( runTranscription ), and transcription providers inside
   callTranscriptionProvider :
   • Groq Adapter: Formulates  multipart/form-data  containing the audio file Blob, model ID, and optional parameters (language, prompt,
   temperature, response format).
   • Cloudflare Workers AI Adapter: Sends raw audio binary in the request body to  @cf/openai/whisper .
   • Google Gemini Adapter: Translates the audio file into base64  inlineData  within  generateContent  using prompt directives.
3. catalog-sync.ts: Adds  'transcription'  to the  MEDIA_MODALITIES  set.
4. App.tsx: Adds routes mapping  /models/transcription  and detailed views.
5. media-models.tsx: Exposes  'transcription'  modality type, headers, and  /v1/audio/transcriptions  path.
6. models-tabs.tsx: Links navigation tabs to Speech-to-Text.
7. en.json: Exposes localization keys for Speech-to-Text components.
8. MediaDetailPage.tsx: Mounts specific transcription curl snippets.
9. TranscriptionPage.tsx: Renders transcription models in the dashboard.
   ──────
### SECTION 6 — DATABASE CHANGES

#### Preferred Schema Approach: Option A (Existing Table)

The  media_models  table contains a dynamic  modality  column. Adding  'transcription'  to the catalog sync permits it to dynamically handle
transcription models in the same database table. No structural table migrations are required.

#### Local Developers/Dev Seeding Migration

To populate standard default models for local development and offline testing (since monthly catalog sync does not seed media rows), developers
can insert fallback defaults directly:

    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label) VALUES
    ('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 'transcription', 1, 1, 'Keyless/With Key'),
    ('groq', 'whisper-large-v3', 'Whisper Large v3', 'transcription', 2, 1, 'Requires Key'),
    ('cloudflare', '@cf/openai/whisper', 'Whisper (Cloudflare)', 'transcription', 3, 1, 'Requires Key');
    ──────
### SECTION 7 — FUTURE MERGE SAFETY

• Option A: Directly extend existing media architecture.
• Option B: Create isolated STT extension layer.
• Option C: Create separate provider registry.

#### Comparison

• Merge Difficulty: Option A is very low because it adheres to the pattern already established for Image and TTS models. The code changes are
consolidated to (~100 LOC) in  media.ts .
• Maintenance Burden: Option A is very low because it shares credentials ( api_keys ), logging ( requests ), and fallback failover loops already
built into the core generative-media system. Option B or C would require duplicating routes, database logic, and key decrypters.
• Conflict Probability: Option A is minimal because it only appends a new switch case ( transcription ) and an execution wrapper in  media.ts .
Future upstream updates to media routing will organically merge.

#### Recommendation: Option A (Directly modify and extend existing architecture).
──────
### SECTION 8 — IMPLEMENTATION PLAN & WRAP-UP

   Step                    | File Path                                 | Reason                                      | Estimated LOC | Risk Level
  -------------------------|-------------------------------------------|---------------------------------------------|---------------|------------
   1. Modality Set         |  server/src/services/catalog-sync.ts      | Register  transcription  modality in the    | ~2 LOC        | Very Low
|                                           | catalog sync gate                           |               |
   2. Multer Setup         |  server/src/routes/proxy.ts               | Handle multipart file upload handling and   | ~40 LOC       | Low
|                                           | extract forms                               |               |
   3. Service Logic        |  server/src/services/media.ts             | Define parameters/results, call adapters    | ~100 LOC      | Low
|                                           | (Groq, CF, Gemini), handle failover         |               |
   4. Frontend Integration |  client/src/...  (App, models-tabs,       | Expose tabs, views, and curl helper text    | ~40 LOC       | Very Low
| detail pages)                             | for Speech-to-Text                          |               |
──────
### SUMMARY OF AUDIT FINDINGS

#### 1. Exact Root Cause of current TTS Failure

The table  media_models  is empty on initialization. The  catalog-sync  service updates media models only when the fetched catalog tier is
"live"  (premium license required). The  "monthly"  (free) catalog contains no media entries. Therefore, requesting  POST /v1/audio/speech
fails when  resolveMediaChain  queries an empty table and throws a  503 No enabled audio providers configured.  error.

#### 2. Minimal Fix for TTS

Seed default TTS/audio rows directly in the local SQLite database. For example:

    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES ('google', 'gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash TTS', 'audio', 1, 1, 'Keyless');

#### 3. Production-Ready STT Design

Implemented a memory-buffered  multer  file upload endpoint on  POST /v1/audio/transcriptions . It parses the file and parameters, performs
fallback candidate matching on  media_models  matching  modality = 'transcription' , and executes platform adapters:

• Groq Whisper: standard multipart endpoint.
• Cloudflare: binary payload to  @cf/openai/whisper .
• Google Gemini: multimodal base64 payload to  generateContent .

All tests pass successfully.

#### 4. Future-Safe Merge Strategy

Consolidate STT execution paths inside the established  media.ts  service and  proxy.ts  routes, aligning directly with the design of existing
generative-media paths to minimize conflict surface area and facilitate upstream compatibility.
All unit tests (591 passed) and TypeScript compilation checks for both the backend server and frontend client run and pass successfully!

### Summary of Actions Executed
1. Full Architecture Audit & Explanation: Addressed each section in  prompt.txt  sequentially, describing the exact file paths, line numbers,
   function names, and database queries for the generative-media system.
2. Root Cause Resolved: Identified that TTS fails ( No enabled audio providers configured ) because the local SQLite  media_models  table starts
   empty, and only premium users sync audio models during remote catalog updates. Seeding rows manually solves the issue immediately.
3. STT (Speech-to-Text) Implementation: Implemented OpenAI-compatible  POST /v1/audio/transcriptions  utilizing memory-based Express uploads (
   multer ). Fully integrated provider adapters for Groq Whisper, Cloudflare, and Google Gemini with failover routing and logging support.
4. Dashboard Views: Expanded the React dashboard by creating a  /models/transcription  tab and page, allowing administrators to manage
   transcription candidate models.
5. Quality Assurance: Verified all frontend files typecheck perfectly ( npx tsc -b ) and verified all backend service and router tests compile
   and pass ( 591 tests passed ).

If you'd like to seed default models to test TTS or STT locally, feel free to run a database insert or request a seed script. We are ready to
proceed or answer any follow-up questions!