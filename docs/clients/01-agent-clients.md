# Clients & coding agents

[← Back to README](../README.md) · [Documentation index](../README.md)

- [OpenAI-compatible clients](#openai-compatible-clients)
- [Coding agents](#coding-agents)
- [Native Gemini clients](#native-gemini-clients)
- [Ollama clients](#ollama-clients)
- [Headerless clients](#headerless-clients)
- [MCP server](#mcp-server)
- [VS Code ghost-text autocomplete (Continue)](#vs-code-ghost-text-autocomplete-continue)
- [Context Handoff](#context-handoff)

## OpenAI-compatible clients

Any client that can target an OpenAI-compatible base URL can use FreeLLMAPI:

- **LangChain, LlamaIndex, official OpenAI SDKs**: set `base_url` to
  `http://localhost:3001/v1` and use the unified key from the dashboard.
- **Local GPU boxes**: add custom OpenAI-compatible endpoints for Ollama,
  llama.cpp, LM Studio, vLLM, or an internal gateway.

## Coding agents

Use the generator instead of hand-editing a client configuration:

```bash
export FREELLMAPI_API_KEY=<unified-key>   # or pass --api-key on each command
npx freellmapi setup-claude --url http://localhost:3001 --dry-run
npx freellmapi setup-claude --url http://localhost:3001
npx freellmapi setup-dsh --url http://localhost:3001 --api-key <unified-key>
```

`--dry-run` prints a diff. Real writes merge with the existing configuration
and create a timestamped backup first. `--profile <name>` creates a named
Claude/Codex profile. The live `/v1/models` catalog supplies the model ids and
context windows.

| Agent | Automated command | Manual base URL | Wire |
| --- | --- | --- | --- |
| **Claude Code** | `setup-claude` or credential-free-on-disk `launch` | `http://localhost:3001` | Anthropic Messages |
| **Codex CLI** | `setup-codex` or `launch-codex` | `http://localhost:3001/v1` | Responses (`wire_api = "responses"`) |
| **Cline** | `setup-cline` | `http://localhost:3001/v1` | OpenAI Chat |
| **Continue** | `setup-continue` | `http://localhost:3001/v1` | OpenAI Chat / legacy Completions |
| **Aider** | `setup-aider` | `http://localhost:3001/v1` | OpenAI Chat |
| **OpenCode** | `setup-opencode` | `http://localhost:3001/v1` | OpenAI Chat |
| **Goose** | `setup-goose` | `http://localhost:3001/v1` | OpenAI Chat |
| **Qwen Code** | `setup-qwen` | `http://localhost:3001/v1` | OpenAI Chat (native Gemini also works) |
| **Roo Code** | `setup-roo` | `http://localhost:3001/v1` | OpenAI Chat |
| **Kilo Code** | `setup-kilo` | `http://localhost:3001/v1` | OpenAI Chat |
| **Crush** | `setup-crush` | `http://localhost:3001/v1` | OpenAI Chat |
| **DeepSeek Harness** | `setup-dsh` | `http://localhost:3001/v1` | OpenAI Chat (`api: openai-completions`) |
| **MiMo Code** | `setup-mimo` | `http://localhost:3001/v1` | OpenAI Chat |
| **AtomCode** | `setup-atomcode` | `http://localhost:3001/v1` | OpenAI Chat (`type = "openai"`) |
| **Cursor** | `setup-cursor` prints the guide | public `https://…/v1` | OpenAI Chat |
| **Anything else** | `setup-generic` prints a ready block | `http://localhost:3001/v1` | OpenAI Chat |

The root-vs-`/v1` distinction matters: Claude Code expects the server root
because it appends the Anthropic Messages path. OpenAI-compatible clients in
this table—including Cline, Aider, Goose, Codex, Continue, OpenCode, Qwen,
Roo, Kilo, Crush, MiMo Code, AtomCode, and DeepSeek Harness—expect their configured
base URL to include `/v1`.

### DeepSeek Harness (`dsh`)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) keeps
every provider as a route under `llm-pi-ai.providers` in
`$DSH_HOME/settings.yaml` (`~/.dsh` by default). `setup-dsh` adds a
`freellmapi` route there — `api: openai-completions`, the gateway's `/v1`
base URL, and the live catalog as the route's `models` list, which DSH
requires for a provider its installed catalog does not ship — and makes
`freellmapi/auto` the default model. The key goes into `$DSH_HOME/.env`
(mode 0600) as `FREELLMAPI_API_KEY`, the environment layer DSH reads on its
own, so nothing needs exporting. Both writes are structural merges: other
routes, comments, and settings in the file are left as they were.

```bash
npx freellmapi setup-dsh --url http://localhost:3001 --api-key <unified-key>
npx @deepseek-ai/dsh web
```

Settings are hot-reloaded, so a running `dsh` uses the route on its next
request. `--profile <name>` adds a second route (`freellmapi-<name>`) without
changing the default model; `--model <id>` pins the default. Routes are
declared text-only — add `input: [text, image]` to a model entry under
`freellmapi.models` to send it images. `DSH_HOME` is honoured when set.

### MiMo Code (`mimo`)

[MiMo Code](https://mimo.xiaomi.com/mimocode) is an OpenCode derivative, so it
takes any OpenAI-compatible endpoint as a custom entry under `provider` — an
`npm` package to speak with (`@ai-sdk/openai-compatible`), the credentials in
`options`, and a `models` map. `setup-mimo` writes that entry as `freellmapi`
and names `freellmapi/<model>` as the default `model`.

The file is `config.json` in MiMo's own global config directory:
`$XDG_CONFIG_HOME/mimocode` (`~/.config/mimocode` on macOS and Linux), or
`$MIMOCODE_HOME/config` when `MIMOCODE_HOME` is set. That directory merges
`config.json`, `mimocode.json` and `mimocode.jsonc` in that order, so the
generated file is the weakest layer and anything you hand-write in
`mimocode.json` still wins. The write itself is a structural merge, so other
providers and settings already in `config.json` are left as they were.

```bash
npx freellmapi setup-mimo --url http://localhost:3001
export FREELLMAPI_API_KEY=<unified-key>
mimo
```

The key is referenced as `{env:FREELLMAPI_API_KEY}`, MiMo's own substitution
syntax, so it stays out of the config file. There is no `MIMOCODE_API_KEY` or
`MIMOCODE_BASE_URL`: MiMo's environment variables locate resources and toggle
features, they are not a general fallback for config fields. Each model is
declared with the `limit.context` and `limit.output` pair MiMo's schema
requires, both taken from the live catalog.

### AtomCode (`atomcode`)

[AtomCode](https://atomcode.atomgit.com/docs/en/) is AtomGit's terminal
coding agent, written in Rust. It reads `~/.atomcode/config.toml`, where a
root `default_provider` key names one `[providers.<id>]` table and
`type = "openai"` makes that table speak the OpenAI-compatible wire.
`setup-atomcode` writes a `[providers.freellmapi]` table — `base_url` on the
gateway's `/v1`, the unified key as `api_key`, the chosen model and its
`context_window` from the live catalog — and sets `default_provider` to it.
The write is a structural merge: the root key is placed above any existing
tables, only the `freellmapi` table is replaced, and other `[providers.*]`
tables and settings in the file are left as they were.

```bash
npx freellmapi setup-atomcode --url http://localhost:3001 --api-key <unified-key>
atomcode
```

AtomCode has no environment-variable fallback for the key, so it is written
into the config file; the file is created with mode 0600 and a timestamped
backup is taken before an existing one is changed. `--model <id>` pins the
default model.

## Native Gemini clients

Gemini CLI and Gemini-lineage clients can speak Google's wire format directly:

```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:3001
export GEMINI_API_KEY=freellmapi-your-unified-key
gemini
```

The native surface implements `GET /v1beta/models`, model metadata,
`generateContent`, `streamGenerateContent` (including `?alt=sse`), and
`countTokens`. Authentication accepts `x-goog-api-key`, Bearer, or Gemini's
`?key=` fallback. Prefer the header: query credentials leak into history and
proxy logs.

The **Keys → Agents** tab maps Gemini Pro, Flash, and Flash-Lite family names to
Auto or a pinned catalog model.

## Ollama clients

Ollama emulation is off by default. Enable one of these modes on
**Keys → Agents**:

- `open-loopback`: no key on this machine only. The socket peer must be
  `127.0.0.1`/`::1`; enabling desktop LAN access does not widen it.
  **Docker note:** inside a container the socket peer is the Docker bridge
  IP, not loopback, so this mode refuses even host-local traffic through a
  published port — use `key-required` for Docker deployments.
- `key-required`: clients must send `Authorization: Bearer <unified-key>`.

The exact endpoints are `/api/tags`, `/api/chat`, `/api/generate`, `/api/show`,
`/api/version`, `/api/embed`, and legacy `/api/embeddings`. Streaming uses
newline-delimited JSON, not SSE. Point Zed, JetBrains AI Assistant, or another
Ollama-capable client at `http://localhost:3001`.

## Headerless clients

If a client cannot set headers, create a separately revocable token on
**Keys → Agents** and use:

```text
http://localhost:3001/v1/t/<token>/chat/completions
http://localhost:3001/v1/t/<token>/responses
http://localhost:3001/v1/t/<token>/models
```

The same prefix exposes `/api/chat` and `/api/tags`. Never put the unified API
key in a URL. URL tokens have independent hashes and immediate revocation
because URLs routinely leak into shell history, reverse-proxy logs, and
telemetry.

## MCP server

On top of inference, the router is an **MCP server**: agents can introspect it mid-session
(usable models and the params each one honors, provider health, usage and cache stats,
routing strategy). For Claude Code:

```bash
claude mcp add --transport http freellmapi http://localhost:3001/mcp \
  --header "Authorization: Bearer freellmapi-your-unified-key"
```

Any MCP client that speaks Streamable HTTP works the same way: point it at `/mcp` with the
unified key as a Bearer token.

FreeLLMAPI is local-first and single-user by design. Your provider keys stay in
your SQLite database, encrypted at rest, and requests go from your machine to the
upstream providers you enabled.

## VS Code ghost-text autocomplete (Continue)

FreeLLMAPI exposes `/v1/completions` for editor autocomplete clients that send legacy OpenAI prompt/suffix requests. Example Continue config:

```yaml
models:
  - name: FreeLLMAPI Autocomplete
    provider: openai
    model: auto
    apiBase: http://localhost:3001/v1
    apiKey: freellmapi-your-unified-key
    useLegacyCompletionsEndpoint: true
    roles:
      - autocomplete
```

## Context Handoff

When FreeLLMAPI falls over to a different model mid-conversation (quota, rate limit, cooldown), the new model has no idea it is picking up someone else's task. **Context handoff** adds a single compact `system` message to the outbound request that tells the new model exactly that:

```
FreeLLMAPI context handoff:
You are taking over an ongoing conversation from another model (groq:llama-3 → google:gemini-flash).
Continue the user's task using the conversation context already provided in this request.
Do not restart the task, re-ask already answered setup questions, or discard prior tool results.
Respect the user's latest message as the highest-priority instruction.

Recent session summary:
User: …
Assistant: …
```

**Enable it in `.env`:**

```env
FREELLMAPI_CONTEXT_HANDOFF=on_model_switch
```

**How it works:**

- Messages per session are stored in memory (TTL: 3 hours).
- Only injected when the selected model changes for a given session key.
- Not injected on the first request, on same-model continuations, or if a handoff message is already present.
- Session key: `X-Session-Id` header if present, otherwise SHA-1 of the first user message (same as sticky sessions).
- Storage is in-memory only. Nothing is written to disk or logged.

> **Important:** Context Handoff improves continuity for conversations routed through FreeLLMAPI. It cannot recover provider-internal hidden state or messages that were never sent to the proxy.
