# freellmapi

Point your coding agent at a [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)
gateway in one command. The generators read the models your server is actually
serving and write the config file each tool expects.

```bash
npx freellmapi setup-claude --url http://localhost:3001 --api-key <your-key>
```

No install step, no account. The unified API key comes from your FreeLLMAPI
dashboard (or the tray popover in the desktop app).

## Commands

| Command | Tool |
| --- | --- |
| `setup-claude` | Claude Code |
| `setup-codex` | Codex CLI |
| `setup-cline` | Cline |
| `setup-continue` | Continue |
| `setup-aider` | Aider |
| `setup-opencode` | OpenCode |
| `setup-goose` | Goose |
| `setup-qwen` | Qwen Code |
| `setup-roo` | Roo Code |
| `setup-kilo` | Kilo Code |
| `setup-crush` | Crush |
| `setup-dsh` | DeepSeek Harness (`dsh`) |
| `setup-mimo` | MiMo Code (`mimo`) |
| `setup-atomcode` | AtomCode (`atomcode`) |
| `setup-openclaw` | OpenClaw |
| `setup-hermes` | Hermes Agent (`hermes`) |
| `setup-pi` | Pi (`pi`) |
| `setup-reasonix` | Reasonix (`reasonix`) |
| `setup-zcode` | ZCode (`zcode`) |
| `setup-zero` | Zero (`zero`) |
| `setup-cursor` | Cursor |
| `setup-generic` | Any OpenAI-compatible client |
| `launch` | Run Claude Code with credentials injected into the child process |
| `launch-codex` | Run Codex the same way |
| `list` | Print the supported tools and their base URLs |
| `keys` | Add, list, remove, test, enable, or disable provider keys (`keys --help`) |
| `models` | List models of any kind, enable or disable them, add chat models from a file (`models --help`) |
| `settings` | Read or change router settings (`settings --help`) |
| `test-sample` | Live-test a random sample of enabled chat models |
| `status` | Gateway reachability, version, keys per platform, enabled models per kind |
| `usage` | Request totals and per-provider split |
| `requests` | Recent request log |

## Options

| Flag | Meaning |
| --- | --- |
| `--url URL` | Gateway base URL (default `http://localhost:3001`) |
| `--api-key KEY` | Unified API key |
| `--profile NAME` | Name the generated profile/provider entry |
| `--model ID` | Pin a specific model instead of the catalog default |
| `--dry-run` | Print the diff and write nothing |

`FREELLMAPI_URL` and `FREELLMAPI_API_KEY` work in place of `--url` / `--api-key`.

## Provider keys

The `keys` commands use a **dashboard session token**. Set
`FREELLMAPI_DASHBOARD_TOKEN`, or pass `--token TOKEN` to override it. This is the
session returned by dashboard sign-in (stored in the signed-in browser's local
storage as `freellmapi_dashboard_token`). The unified `--api-key` /
`FREELLMAPI_API_KEY` used by coding agents cannot authenticate these commands.
The CLI does not log in or persist the dashboard token.

```bash
export FREELLMAPI_URL=http://localhost:3001
export FREELLMAPI_DASHBOARD_TOKEN='<dashboard-session-token>'

npx freellmapi keys add groq                 # hidden provider-key prompt
npx freellmapi keys add groq --key '<key>'   # non-interactive alternative
npx freellmapi keys list
npx freellmapi keys test groq                # check every stored Groq key
npx freellmapi keys test groq --id 7         # check one key
npx freellmapi keys remove groq --id 7
npx freellmapi keys disable groq             # every Groq key
npx freellmapi keys enable groq --id 7       # one key
```

`keys list` prints each key's ID, platform, enabled chat model count,
enabled/disabled state, and stored health status. Counts respect the key's model
scope; custom keys count models registered to their endpoint. Credentials and
masked keys are never printed. Use the IDs from this list when a platform has
multiple keys: `remove` requires `--id` in that case, and also checks that the ID
belongs to the requested platform. With one matching key, `--id` is optional.

`add` saves the key and immediately validates it through the gateway. A failed or
inconclusive check exits with code 1 and **leaves the key saved** for later testing
or removal. `test` also exits with code 1 if any selected key is not healthy or the
gateway cannot confirm its validity (for example, after a provider network
failure). Successful commands exit with code 0; argument, authentication, and
request errors exit with code 1. Validation uses the gateway's usual health
checks, including its policy of disabling a key after repeated confirmed failures.

`keys enable` and `keys disable` switch one key with `--id`, or every key of the
platform without it (`PATCH /api/keys/platform/:platform`).

Keyless providers skip the prompt. Custom endpoints need a URL and model
registration, so create them in the dashboard; existing custom keys can be
listed, tested, and removed here. Requests accept `--url` / `FREELLMAPI_URL` and
`--timeout MS` (30,000 ms per request by default). `--dry-run` is not supported for
`keys`; it is rejected before any request.

## Models

Dashboard-token commands to see and switch models. `--kind` picks the catalogue:
`chat` (default), `media`, `embedding`, `search` (search engines), or `decision`.
IDs are the numeric IDs shown by `models list`.

```bash
npx freellmapi models list --platform groq --disabled
npx freellmapi models list --kind embedding --json
npx freellmapi models enable 42 43
npx freellmapi models disable 5 --kind media
npx freellmapi models add new-models.json --dry-run
```

`list` accepts `--platform a,b`, `--enabled` or `--disabled`, and `--json`. `enable`
and `disable` check every ID against the list first and change nothing when one is
unknown. Enabling a chat model also turns its routing switch back on. Output never
includes provider keys or the dashboard token.

`add <file.json>` registers chat models from a JSON array of objects, for example
`[{"platform":"groq","modelId":"my-model","contextWindow":131072}]`. Fields are
those of `POST /api/models`: `platform` and `modelId` are required;
`displayName`, `contextWindow`, `rpmLimit`, `rpdLimit`, `tpmLimit`, `tpdLimit`,
`monthlyTokenBudget`, `supportsVision`, `supportsTools`, `keyId`, and
`endpointScope` are optional. Every row is checked before the first request. It
then prints one line per row (`added`, `present`, or `failed`), reads
`/api/models` back to confirm, and exits 1 if any row failed. `--dry-run` reads
the list and prints what would be added without sending a POST.

## Settings

```bash
npx freellmapi settings get
npx freellmapi settings get output-limit
npx freellmapi settings set output-limit '{"mode":"auto"}'
npx freellmapi settings set guardrails '{"maxConsecutiveUpstreamFails":3}' --dry-run
```

`get` prints one setting, or all of them as one JSON object. `set` checks the
JSON locally, sends it as the body of `PUT /api/settings/<name>`, and prints the
stored result; `--dry-run` stops after the check. The names are `agent-compatibility`,
`anthropic-map`, `compression`, `enable-mcp`, `fusion`, `gemini-map`, `guardrails`,
`headroom`, `min-context-window`, `min-reliability-floor`, `output-limit`,
`provider-moment-attribution`, `system-date`, `task-weight-share`, `unify`, and
`update-check`; `settings --help` shows an example body for each. The PUT body of
`fusion`, `anthropic-map`, and `gemini-map` is the config or map itself, while their
GET output wraps it (`{config, maxK}`, `{map}`). `api-key`, `url-tokens`, and
`proxy` are not exposed.

## Test sample

```bash
npx freellmapi test-sample --platform groq,cerebras -n 2 --seed 7
npx freellmapi test-sample --all --pace 5
```

Picks at most `-n` (default 2) enabled chat models per platform and tests them
one at a time through `POST /api/models/:id/test`, pausing `--pace` seconds
(default 2) between calls. The server allows one test per model every five
seconds, so a 429 is retried once after that window. The table lists model,
result, latency, and a one-line error; the exit code is 1 if any test failed.
The seed is printed, and `--seed N` repeats the same sample. `--dry-run` prints the
sample without testing. Tests send a real request upstream and use free-tier quota.

## Status, usage and request log

Read-only commands for checking on a running gateway. `usage` and `requests`
authenticate like `keys` (the dashboard session token above); `status` works
without a token and adds keys and model counts when one is set. All three print
a table by default and JSON with `--json`.

```bash
npx freellmapi status
npx freellmapi usage --range 30d --top 5
npx freellmapi requests --status error --limit 50
```

| Command | Flags | Output |
| --- | --- | --- |
| `status` | | Reachability and version from `/livez`. With a token: keys per platform (total, enabled, healthy) and enabled/total models for chat, media, embedding, search, and decision. Exits 1 if the gateway is unreachable or unavailable. |
| `usage` | `--range 24h\|7d\|30d\|all` (default `7d`), `--top N` (default 10) | Requests, success rate, tokens, and latency for the range, then one row per provider or custom endpoint, busiest first. |
| `requests` | `--range` (default `24h`), `--status success\|error\|canceled`, `--limit N` (default 20, at most 500) | Newest requests first: time, status, type, model, latency, tokens, and a one-line error. |

Output never includes provider keys, masked keys, or the dashboard token.
`--url`, `--token`, and `--timeout` behave as for `keys`; `--dry-run` is rejected.

## Safety

Every generator is non-destructive: it merges into your existing configuration
rather than replacing it, and takes a timestamped backup before touching a file
that already exists. `--dry-run` shows the exact diff first.

The two `launch` commands never write credentials to disk at all — they inject
them into the child process environment for that run only.

## Requirements

Node.js >= 20.18. A running FreeLLMAPI gateway
([install guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md)).

## Links

- [Clients & coding agents guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/clients/01-agent-clients.md)
- [Issue tracker](https://github.com/tashfeenahmed/freellmapi/issues)

MIT © Tashfeen Ahmed
