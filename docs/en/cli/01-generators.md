**English** · [简体中文](../../zh-cn/cli/01-generators.md)

# Setup generators

## Usage

```bash
npx freellmapi setup-claude        # wire Claude Code
npx freellmapi setup-codex         # wire Codex CLI
npx freellmapi setup-dsh           # wire DeepSeek Harness
npx freellmapi setup-mimo          # wire MiMo Code
npx freellmapi setup-atomcode      # wire AtomCode
npx freellmapi --dry-run setup-claude  # preview without writing
npx freellmapi setup-claude --model gpt-4o  # pin a model
```

Every generator (`cli/src/tools.ts:52-622`) fetches the live catalog, resolves `--model` against the unfiltered catalog (`c942352`), backs up existing config with a timestamped copy, merges without clobbering unrelated keys, and writes with `0600`.

## Generator table

| Command | Target file | Protocol | Notes |
| --- | --- | --- | --- |
| `setup-claude` | `~/.claude/settings.json` | Anthropic Messages | `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`MODEL`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, `launch` zero-persistence launcher |
| `setup-codex` | `~/.codex/config.toml` | OpenAI Responses | `[model_providers.freellmapi]` `wire_api=responses`, `launch-codex` launcher |
| `setup-cline` | `~/.config/Code/User/settings.json` | OpenAI Chat | Cline VS Code extension |
| `setup-continue` | `~/.continue/config.json` | OpenAI Chat | Continue ghost-text autocomplete |
| `setup-aider` | `~/.aider.conf.yml` | OpenAI Chat | Aider pair-programmer |
| `setup-opencode` | `~/.config/opencode/opencode.json` + key in `~/.local/share/opencode/auth.json` | OpenAI Chat | OpenCode agent |
| `setup-goose` | `~/.config/goose/config.yaml` | OpenAI Chat | Goose agent |
| `setup-qwen` | `~/.qwen/settings.json` | OpenAI/Gemini | Qwen Code, `/v1` or native `/v1beta` |
| `setup-roo` | `~/.config/roo/config.json` | OpenAI Chat | Roo Code |
| `setup-kilo` | `~/.config/kilo/config.json` | OpenAI Chat | Kilo Code |
| `setup-crush` | `~/.config/crush/config.json` | OpenAI Chat | Crush (charmbracelet) |
| `setup-dsh` | `~/.dsh/config.json` | OpenAI Chat | DeepSeek Harness (#995) |
| `setup-mimo` | `~/.config/mimocode/config.json` | OpenAI Chat | MiMo Code `~/.config/mimocode/config.json` `default_provider=freellmapi` + `[providers.freellmapi]` `type=openai` `base_url=/v1` `api_key` `model` `context_window` (#1003) |
| `setup-atomcode` | `~/.atomcode/config.toml` | OpenAI Chat | `default_model=freellmapi` + `[provider_accounts.freellmapi]` + `[models.freellmapi]`; preserves unrelated configuration |
| `setup-cursor` | guide only | OpenAI Chat | Manual `Cursor Settings → Models → Add Model` (no file) |
| `setup-generic` | guide only | OpenAI Chat | Any OpenAI-compatible client |

## Zero-persistence launchers

```bash
npx freellmapi launch            # injects FREELLMAPI_API_KEY + model into `claude`
npx freellmapi launch-codex      # injects into `codex --profile NAME`
```

These do not write config files; they spawn the child process with `FREELLMAPI_API_KEY`/`FREELLMAPI_MODEL` in env only. Useful for ephemeral or shared machines.

## `freellmapi doctor`

```bash
npx freellmapi doctor
```

Proves a client's requests reach this gateway (checks routed `Authorization` header, catalog, live probe).

## Status, usage and request log

```bash
npx freellmapi status
npx freellmapi usage --range 30d --top 5
npx freellmapi requests --status error --limit 50
```

Read-only views of a running gateway, backed by `/livez` and `/api/analytics/{summary,by-platform,requests}` (`cli/src/status.ts`, `cli/src/analytics.ts`). Each prints a table, or JSON with `--json`.

| Command | Flags | Output |
| --- | --- | --- |
| `status` | | Reachability and version (no token needed). With `FREELLMAPI_DASHBOARD_TOKEN` or `--token`: keys per platform and enabled/total models for chat, media, embedding, search, decision. Exit 1 when unreachable or unavailable. |
| `usage` | `--range 24h\|7d\|30d\|all` (default `7d`), `--top N` (default 10) | Totals plus one row per provider or custom endpoint. |
| `requests` | `--range` (default `24h`), `--status success\|error\|canceled`, `--limit N` (default 20, max 500) | Newest requests first with a one-line error. |

`usage` and `requests` need the dashboard session token, shared with `keys` through `cli/src/dashboard.ts`. Provider keys and the token are never printed.

## Models and key switches

```bash
npx freellmapi models list --kind media --disabled
npx freellmapi models enable 42 43
npx freellmapi keys disable groq --id 7
```

`models` (`cli/src/dashboard-models.ts`) lists and toggles models through the dashboard route of each kind: `/api/models`, `/api/media`, `/api/embeddings`, `/api/search/engines`, `/api/decisions/models`. `--kind chat|media|embedding|search|decision` (default `chat`); `list` also takes `--platform a,b`, `--enabled|--disabled`, `--json`. Embedding toggles go in one `PUT /api/embeddings` that keeps each row's priority. `keys enable|disable <platform> [--id N]` uses `PATCH /api/keys/:id`, or `PATCH /api/keys/platform/:platform` without `--id`. Both need the dashboard session token.

## Common flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | Preview changes without writing; shows diff |
| `--model <id>` | Pin to a model (resolved against unfiltered catalog) |
| `--profile <name>` | Named profile (Codex `codex --profile NAME`, Claude `CLAUDE_CONFIG_DIR`) |

## Related

- [Config files](02-config-files.md) — merge strategies, `tools.json`, adding a new generator.
- [Clients & agents](../clients/01-agent-clients.md) — per-agent wiring recipes, headerless URL tokens, MCP.
