# Environment variable reference

Every variable FreeLLMAPI reads from `.env`, grouped by concern. Defaults and descriptions are derived only from the comments and values in [`.env.example`](../../.env.example). Variables shown commented out in `.env.example` are optional; their documented default is listed here.

- [Server & binding](#server--binding)
- [Outbound proxies (local destinations)](#outbound-proxies-local-destinations)
- [Security & encryption](#security--encryption)
- [Rate limits](#rate-limits)
- [Routing overrides, timeouts & failover](#routing-overrides-timeouts--failover)
- [Outbound proxies](#outbound-proxies)
- [Request body & media limits](#request-body--media-limits)
- [Storage, cache, analytics & misc](#storage-cache-analytics--misc)

Related reading: [02-security-and-keys.md](02-security-and-keys.md) expands on `ENCRYPTION_KEY`; [03-outbound-proxies.md](03-outbound-proxies.md) expands on the proxy chain.

## Server & binding

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Server port. |
| `HOST` | `::` (dual-stack IPv4+IPv6) | Network interface the server listens on. Hosts with IPv6 disabled fall back to IPv4 automatically. Set `0.0.0.0` for IPv4-only or `127.0.0.1` to restrict to localhost. Distinct from `HOST_BIND`, which only affects Docker port publishing. |
| `HOST_BIND` | `127.0.0.1` | Docker only: which host interface the container's port is published on. The default keeps the dashboard/API reachable only from the machine running Docker; set `0.0.0.0` to open it to the LAN (e.g. a Raspberry Pi at `http://192.168.1.x:3001`) — only on a trusted network, since the proxy is single-user and guarded only by the unified API key. |
| `DASHBOARD_ORIGINS` | `localhost:5173`, `127.0.0.1:5173`, `[::1]:5173` allowed | Comma-separated extra origins allowed to call the API from a browser. Only needed if you serve the dashboard from a different host than the API (e.g. `http://my-server.local`). |
| `CSP_UPGRADE_INSECURE_REQUESTS` | Auto (unset) | Controls the Content-Security-Policy `upgrade-insecure-requests` directive (#682). Unset: emit only when the request arrives over TLS or behind an HTTPS reverse proxy (`X-Forwarded-Proto: https`), so plain-HTTP LAN installs stay renderable. `true`: force the directive on even over plain HTTP (rarely useful). `false`: force it off even behind HTTPS (e.g. mixed-content reverse proxies). |

## Outbound proxies (local destinations)

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREEAPI_PROXY_LOCAL_DESTINATIONS` | `false` | Allow proxying localhost/LAN destinations (Ollama, llama.cpp, LM Studio). By default local and LAN destinations (localhost, 127.0.0.0/8, ::1, 0.0.0.0, RFC1918/ULA/CGNAT addresses) always bypass the outbound proxy — a remote proxy has no route back to your own machine. Set to `true` only when proxying them is the point, e.g. an `ssh -D` dynamic tunnel where `http://127.0.0.1:11434` through the SOCKS proxy is meant to reach the **remote** host's Ollama. |

## Security & encryption

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENCRYPTION_KEY` | Placeholder value; required in production, auto-generated key file outside production | Server encryption key for API-key storage. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Precedence: this env var, then a `.encryption-key` file next to the SQLite database (not inside it, 0600 permissions), then a legacy key found in the old settings table (migrated to the file on first boot), then a freshly generated key. See [02-security-and-keys.md](02-security-and-keys.md). |
| `FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS` | Unset — localhost and private LAN addresses stay allowed for custom providers | Custom-provider URL policy. Cloud metadata and link-local addresses (`169.254.169.254`, `metadata.google.internal`, `fe80::/10`, ...) are ALWAYS blocked as custom provider base URLs. Set to `true` to also block loopback and RFC1918/ULA private ranges — recommended when hosting on a VPS or anywhere the dashboard is reachable by others. |
| `FREEAPI_DB_DIR_HARDENING` | Automatic where safe | Whether to restrict the directory holding the database to this account, so the SQLite `-wal`/`-shm` sidecars are protected too (they are created on first write, after any startup permission check could reach them). Done automatically for the default `server/data` directory and for any directory FreeLLMAPI creates itself; skipped for a `FREEAPI_DB_PATH` pointing somewhere pre-existing, since that may be a shared location. Set to `1` to force, `0` to disable entirely. |

First-run note: the first dashboard account is normally created from a browser on the same machine with no extra step. If the server is reachable from other devices, creating that first account also requires a one-time setup code printed in the server logs at startup while no account exists.

## Rate limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_RATE_LIMIT_RPM` | `120` | Max `/v1` proxy requests per minute per client IP. Set to `0` to disable proxy rate limiting. See [03-outbound-proxies.md](03-outbound-proxies.md) for related knobs. |
| `ADMIN_RATE_LIMIT_RPM` | `600` | Max `/api` dashboard requests per minute per client IP. A flood guard — login has its own per-email lockout and key export its own much tighter cap. Set to `0` to disable. |

## Routing overrides, timeouts & failover

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODEL_ROUTING_OVERRIDES` | Unset | Per-model routing score multipliers (#738), JSON object of model id → `0..2`. `1.0` leaves a model unchanged, below `1` demotes it, above `1` promotes it, and `0` means the automatic router never picks it (Manual priority still can). Matching is by model id alone, across all platforms serving that id, exact and case-sensitive; copy ids from the dashboard Models page. An id that matches nothing is silently ignored, but the boot log flags it once the catalog has synced. |
| `PROVIDER_TIMEOUT_<PLATFORM>` | Built-in per provider: `60s` most OpenAI-compatible platforms, `180s` NVIDIA, `120s` Ollama Cloud / AI Horde / custom providers, `60s` Google as registered | Per-provider chat HTTP timeout in milliseconds (platform name upper-cased). On streaming requests this value also serves as the FIRST-BYTE grace budget: how long the stream may stay silent before its first byte (issue #584 — providers like NVIDIA NIM send SSE headers instantly, then prefill long prompts for minutes). `0` disables the timeout entirely. Read at startup. Example: `PROVIDER_TIMEOUT_NVIDIA=300000` gives NVIDIA NIM's slow reasoning models 5 minutes. |
| `PROVIDER_STREAM_STALL_TIMEOUT_MS` | `90000` | Mid-stream inactivity timeout in milliseconds. If an SSE stream goes this long without a single byte AFTER the first byte arrived, the gateway gives up: before any output reached the client it fails over to the next candidate; after output was sent the stream ends with an error frame. Time-to-FIRST-byte is governed by `PROVIDER_TIMEOUT_<PLATFORM>` instead (whichever of the two is larger). Providers that queue heavily on free tiers can pause longer than 90s mid-stream — raise this if streamed responses stop early. `0` disables the stall watchdog entirely. |
| `PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM>` | Falls through to the global value above, then the built-in `90000` | Per-provider variant (platform name upper-cased). Precedence: per-platform > global > built-in 90s default. Example: `PROVIDER_STREAM_STALL_TIMEOUT_OLLAMA=240000` lets Ollama Cloud pause 4 minutes mid-stream without loosening the watchdog everywhere else. |
| `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` | Built-in default per provider | Per-provider daily request cap (platform name upper-cased). Overrides the built-in default for that provider; set to `0` to disable the cap. Example: `PROVIDER_DAILY_REQUEST_CAP_OPENROUTER=50`. |
| `FALLBACK_TIME_BUDGET_MS` | `45000` | Wall-clock budget for provider failover, in milliseconds. A request that keeps failing over stops STARTING new attempts once this much time has passed and returns the exhaustion error instead (the first attempt always runs; an in-flight attempt is never cut off). `0` disables and retries until the attempt cap. Also settable at runtime via the `fallback_time_budget_ms` settings key, which takes precedence. |
| `FALLBACK_DETAIL_HEADER` | Off | Opt-in `X-Fallback-Detail` response header (`=1` enables). `X-Fallback-Trail` already names every hop that failed and why; the detail header adds what each one COST — e.g. `groq/llama-3.3-70b key1=rate_limited t=0+39000ms msg=...` — so a caller can tell one 39s stall apart from four fast failures without opening the dashboard. Off by default because it puts hop timings and provider error text on the response. Runtime override via the `expose_fallback_detail_header` settings key takes precedence. |
| `VALIDATE_TOOL_ARGUMENTS` | Off (`=1` enables) | Check tool-call arguments against the schema the caller declared and fail over when they violate it. `lib/tool-args.ts` already repairs what it can prove is repairable; this catches what is left, which today reaches Anthropic clients as a `tool_use` block with `input: {}`. Off by default because a false positive costs a failover hop — turn it on, watch `X-Fallback-Trail` for `invalid_tool_arguments`, then decide. Applies wherever the turn can still fail over (non-streaming surfaces, plus `/v1/chat/completions`, `/v1/messages`, Gemini and Ollama emulations); `/v1/responses` streaming commits on the first tool-call delta and is the exception. Runtime override via the `validate_tool_arguments` settings key. |
| `REQUEST_MAX_TOKENS_BUDGET` | `0` (off) | Per-request token guardrail: estimated input + requested max_tokens must fit this ceiling or the request is rejected with a 413 before any provider is tried; a request that sent no max_tokens gets its output capped to the remainder instead. Runtime-tunable via the `request_max_tokens_budget` settings key (dashboard API `PUT /api/settings/guardrails`). |
| `MAX_CONSECUTIVE_UPSTREAM_FAILS` | `0` (off) | Failover circuit breaker: after this many consecutive upstream failures in one request, stop the failover chain with a 503 instead of trying every remaining candidate of an unhealthy pool. Runtime-tunable via the `max_consecutive_upstream_fails` settings key. |
| `MODELSCOPE_VALIDATE_CACHE_MS` | `86400000` (24h) | ModelScope (魔搭) validates API keys with a paid 1-token chat completion (`GET /v1/models` does not enforce auth), spending magic-grain (魔粒) quota per probe — observed as 2 魔粒 per ultra-tier request. To stop the 5-minute health pass burning ~288 paid probes per key per day, a successful validation is cached per key for this long (milliseconds). `0` probes on every pass; a revoked key is still caught by the next real request's 401. |
| `FREELLMAPI_CONTEXT_HANDOFF` | Off | Context handoff on model switch. When enabled (`on_model_switch`), FreeLLMAPI injects a compact system message into the outbound request whenever a session switches from one model to another (e.g. after a fallback). |

## Outbound proxies

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_URL` | Unset | Outbound proxy for provider requests. Normally set in the dashboard (Keys → Outbound proxy); env vars exist for headless installs. Schemes: `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h` — the `h`/`a` variants resolve DNS at the proxy, which is what you want on a DNS-poisoned network. Highest link in the precedence chain below. |
| `ALL_PROXY` | Unset | Standard proxy variable, third in the precedence chain. |
| `HTTPS_PROXY` | Unset | Standard proxy variable, fourth in the precedence chain. |
| `HTTP_PROXY` | Unset | Standard proxy variable, last in the precedence chain. |
| `NO_PROXY` | Unset | Hosts that must be reached directly, bypassing the proxy above. Comma-separated; a bare domain also covers its subdomains, and `*` disables the proxy entirely. |

**Precedence:** `PROXY_URL` → dashboard setting → `ALL_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY`. The standard variables are also read in their lower-case spellings.

In Docker, `127.0.0.1` is the container, not your machine — see [03-outbound-proxies.md](03-outbound-proxies.md).

## Request body & media limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `REQUEST_BODY_LIMIT_MB` | `25` | JSON body limit in MB for the inference surfaces (`/v1`, `/v1beta`, `/mcp`, Ollama `/api/*`). Vision requests embed base64 images in the body and replay them with every turn, so large sessions can clear 10MB; this ceiling only gates parsing — inbound image normalization shrinks the payload afterwards. Raise it if bigger payloads are rejected with 413 `request_too_large`. |
| `IMAGE_NORMALIZE` | `on` | Inbound image normalization master switch (`off` disables entirely). Data-URL images over the threshold are downscaled to the long-edge cap and re-encoded (JPEG, or PNG only when the alpha channel carries real transparency) before routing, shrinking replayed screenshots ~6–10x. Also normalizes exotic formats upstreams reject (bmp/gif/tiff/avif/webp → jpeg/png); gif keeps its first frame only. Every upstream resizes internally anyway (OpenAI to 2048px, Anthropic to 1568px), so pixels beyond the cap are transport waste. |
| `IMAGE_NORMALIZE_MAX_DIMENSION` | `2048` | Long-edge cap in pixels for normalized images. |
| `IMAGE_NORMALIZE_THRESHOLD_KB` | `1024` | Images above this size (KB) are candidates for downscaling. |
| `IMAGE_NORMALIZE_QUALITY` | `90` | Re-encode quality for normalized images. |

## Storage, cache, analytics & misc

| Variable | Default | Purpose |
| --- | --- | --- |
| `RESPONSE_CACHE` | `false` | Opt-in response cache. When on, a successful non-streaming `/v1/chat/completions` answer is stored in a bounded in-memory LRU keyed by a canonical hash of the request, so an IDENTICAL later request is served from memory without spending provider quota. Exact match only — a near-miss never returns a different prompt's answer. Toggled at runtime via the dashboard (`PUT /api/cache/config`) and per-request with the `X-FreeLLM-Cache: on\|off` header. A restart flushes it. |
| `RESPONSE_CACHE_TTL_SECONDS` | `3600` (1 hour) | How long a cached answer stays fresh, in seconds. |
| `RESPONSE_CACHE_MAX_TEMPERATURE` | `1.0` | Only cache requests at/below this temperature; higher temperatures want fresh variety. Default caches everything when enabled; lower it (e.g. `0.2`) to cache only near-deterministic calls. |
| `RESPONSE_CACHE_MAX_ENTRIES` | `5000` | Hard cap on stored entries; least-recently-used entries are evicted past this. |
| `FREELLMAPI_COMPRESSION` | `off` | Request-side prompt/context compression. `lossless` applies whitespace hygiene, exact repeated-block references, and reversible tabular-JSON encoding; `standard` also filters tool output and superseded file reads; `aggressive` adds age/relevance/budget condensation. The dashboard can change this live under Settings. A request may lower the configured mode with `X-FreeLLM-Compress`, but cannot override a global `off` master switch. |
| `REQUEST_ANALYTICS_RETENTION_DAYS` | `90` | Request analytics retention in days. Set to `0` to disable this limit. |
| `REQUEST_ANALYTICS_MAX_ROWS` | `100000` | Request analytics row cap. Set to `0` to disable this limit. |
| `REQUEST_ANALYTICS_LOG_CLIENT` | `true` | Per-request caller identity (client IP + User-Agent) recorded into request analytics and shown in the dashboard "Recent calls" table. Set to `false` to store nulls instead (aggregate analytics unaffected). |
| `SERVER_LOGS_RETENTION_DAYS` | `7` | Persisted server logs behind the dashboard's log viewer. Only warn/error lines are written to the database (the live view is an in-memory ring), so these bounds are far tighter than the analytics ones above. Set to `0` to disable this limit. |
| `SERVER_LOGS_MAX_ROWS` | `50000` | Persisted server logs row cap. Set to `0` to disable this limit. |
| `FREEAPI_DB_PATH` | Default location next to the server build | Optional SQLite location override. Useful on hosts where only one directory is mounted persistently, or to keep the DB outside `server/data`. Example: `/app/server/data/freellmapi.db`. |
| `FREEAPI_DB_BACKUP_PATH` | Unset | Optional encrypted SQLite backup target (file path). On startup, FreeLLMAPI restores this backup if the configured DB file is missing; while running, it uploads a fresh backup periodically. |
| `FREEAPI_DB_BACKUP_URL` | Unset | HTTP(S) backup target, alternative to the path above. |
| `FREEAPI_DB_BACKUP_TOKEN` | Unset | Optional bearer token for uploads to `FREEAPI_DB_BACKUP_URL`. |
| `FREEAPI_DB_BACKUP_KEY` | Uses `ENCRYPTION_KEY` if omitted | Separate 64-char hex key for the backup envelope. |
| `FREEAPI_DB_BACKUP_INTERVAL_MS` | `300000` (5 min) | Period between background backups. |
| `FREEAPI_CONFIG_PATH` | Unset | Optional declarative startup config: path to a JSON file applied idempotently after migrations on every boot. Example: `/app/server/data/freellmapi.config.json`. |
| `FREEAPI_CONFIG_JSON` | Unset | Same declarative config inline instead of via file, e.g. `{"keys":[{"platform":"groq","key":"gsk_...","label":"main"}],"routing":{"strategy":"balanced"}}`. |
| `FREELLMAPI_UPDATE_CHECK` | Enabled | Manual application update checker. Set to `off` to hide it from Settings and prevent Git discovery or outbound update-check requests. This also switches off the automatic release reminder, which is a separate dashboard setting (Settings > General) that stays off until turned on there. |
| `FREELLMAPI_UPDATE_GITHUB_TOKEN` | Empty (anonymous checks) | Token used only for update checks against GitHub. The checker is anonymous by default; use a narrowly scoped token only if higher rate limits are needed. Generic `GITHUB_TOKEN` values are intentionally ignored. |
| `FREELLMAPI_COMMIT_SHA` | Injected by official builds | Build metadata identifying the exact commit. Normally should not be set in `.env`. |
| `FREELLMAPI_INSTALL_METHOD` | Injected by official builds (the Docker image sets `docker`) | Install-type metadata used by the update checker. Normally should not be set in `.env`. |
| `CLIENT_DIST` | Bundled client build | Path to a prebuilt client `dist` directory to serve. Set this only if you build the dashboard separately. |
| `FREEAPI_ENV_PATH` | `./.env` | Explicit path to the `.env` file to load. Useful for embedders (e.g. the desktop app, where the code runs from inside a bundle); dotenv silently no-ops on a missing file. |
