# CLI Domain — Overview & File Index

## Scope

This domain documents the FreeLLMAPI setup CLI (`cli/`) — the `npx freellmapi` generators that wire coding agents to the local gateway in one command. Each generator (`setup-claude`, `setup-codex`, …) fetches the live catalog, backs up existing config, never clobbers unrelated keys, and records `tools.json` metadata for `freellmapi launch` / `launch-codex` zero-persistence launchers and `freellmapi doctor`.

Authoritative sources: [`cli/src/tools.ts`](../../../cli/src/tools.ts) (all `Xxx()` generator functions), [`cli/tools.json`](../../../cli/tools.json) (registry), [`cli/src/config-files.ts`](../../../cli/src/config-files.ts) (merge + `0600` + timestamped backup), [`cli/README.md`](../../../cli/README.md), [`client/src/data/agent-tools.json`](../../../client/src/data/agent-tools.json).

For per-agent wiring recipes and the MCP/headerless-client story, see [Clients & coding agents](../clients/OVERVIEW.md). For the env vars the CLI injects (`FREELLMAPI_API_KEY`, `FREELLMAPI_MODEL`), see [env/](../env/OVERVIEW.md).

## File Index

| File | Description |
| --- | --- |
| [01-generators.md](01-generators.md) | All `setup-*` generators (claude/codex/cline/continue/aider/opencode/goose/qwen/roo/kilo/crush/cursor/dsh/mimo/atomcode/generic), target files, merge behavior, `--model` resolution, and `launch`/`launch-codex`/`doctor` commands. |
| [02-config-files.md](02-config-files.md) | Config-file layer: `tools.json` registry, `config-files.ts` merge strategies (JSON/TOML/YAML), `0600` permissions, timestamped backups, `--dry-run`, and how to add a new generator. |
| [CHANGELOG.md](CHANGELOG.md) | Doc revision history for this domain. |

## Navigation

- ← [Documentation root](../README.md)
- ↑ [Docs index](../OVERVIEW.md)
