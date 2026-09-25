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
| `setup-opencode` | `~/.config/opencode/config.json` | OpenAI Chat | OpenCode agent |
| `setup-goose` | `~/.config/goose/config.yaml` | OpenAI Chat | Goose agent |
| `setup-qwen` | `~/.qwen/settings.json` | OpenAI/Gemini | Qwen Code, `/v1` or native `/v1beta` |
| `setup-roo` | `~/.config/roo/config.json` | OpenAI Chat | Roo Code |
| `setup-kilo` | `~/.config/kilo/config.json` | OpenAI Chat | Kilo Code |
| `setup-crush` | `~/.config/crush/config.json` | OpenAI Chat | Crush (charmbracelet) |
| `setup-dsh` | `~/.dsh/config.json` | OpenAI Chat | DeepSeek Harness (#995) |
| `setup-mimo` | `~/.config/mimocode/config.json` | OpenAI Chat | MiMo Code `~/.config/mimocode/config.json` `default_provider=freellmapi` + `[providers.freellmapi]` `type=openai` `base_url=/v1` `api_key` `model` `context_window` (#1003) |
| `setup-atomcode` | `~/.atomcode/config.toml` | OpenAI Chat | AtomCode `default_provider=freellmapi` + `[providers.freellmapi]` TOML preserve other providers (#1025) |
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

## Common flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | Preview changes without writing; shows diff |
| `--model <id>` | Pin to a model (resolved against unfiltered catalog) |
| `--profile <name>` | Named profile (Codex `codex --profile NAME`, Claude `CLAUDE_CONFIG_DIR`) |

## Related

- [Config files](02-config-files.md) — merge strategies, `tools.json`, adding a new generator.
- [Clients & agents](../clients/01-agent-clients.md) — per-agent wiring recipes, headerless URL tokens, MCP.
