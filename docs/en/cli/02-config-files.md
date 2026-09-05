# Config files

## Registry — `cli/tools.json`

`cli/tools.json` is the single source of truth for the generator list. Each entry has `id`, `name`, `category` (`code`|`agent`), `configType` (`file`|`guide`), `protocol` (`Anthropic Messages`|`OpenAI Chat`|`OpenAI Responses`), `baseUrlSupport`, `command` (`setup-*`), and `docsUrl`. `client/src/data/agent-tools.json` is the dashboard copy (keep in sync).

## `cli/src/config-files.ts` — merge layer

Every `Xxx()` generator in `cli/src/tools.ts` returns a `Generation { files: { path, format, sensitive, value }[], notes }`. `config-files.ts` applies each file via:

- **JSON** (`settings.json`, `config.json`) — deep-merge, preserve unrelated keys; `0600` (`0o600`) on write.
- **TOML** (`config.toml` for Codex, AtomCode) — structural merge preserves other `[providers.*]` tables; Codex's single-file `~/.codex/config.toml` uses `[profiles.NAME]` tables, not per-profile files.
- **YAML** (`config.yaml` for Goose) — similar merge.

### Backup

Before first write, `config-files.ts` copies the existing file to `<path>.bak.<ISO timestamp>` (e.g. `settings.json.bak.2026-09-02T10-30-00-000Z`). No backup if the file didn't exist. The backup is also `0600`.

### Dry run

`--dry-run` runs the merge in memory, prints a diff, and exits without touching disk.

### `tools.test.ts` snapshot

`cli/src/__snapshots__/tools.test.ts.snap` pins the generated file contents for each generator; update with `npm run test -- -u` after changing a generator.

## Adding a new generator

1. Add entry to `cli/tools.json` (`id`, `name`, `category`, `configType`, `protocol`, `baseUrlSupport`, `command`, `docsUrl`).
2. Add `function myTool(ctx: GenerateContext): Generation` in `cli/src/tools.ts` — return `files` with correct `path`/`format`/`value` and `notes` for the CLI output. Use helpers `rootUrl()`/`v1Url()`/`primaryModel()`/`contextWindow()`.
3. Add snapshot case in `cli/src/tools.test.ts`.
4. Document in [01-generators.md](01-generators.md) table + `docs/clients/01-agent-clients.md` section.
5. Sync `client/src/data/agent-tools.json` if the dashboard lists it.

## Related

- [Generators](01-generators.md) — all `setup-*` commands and target files.
- [Clients & agents](../clients/01-agent-clients.md) — per-agent recipes.
