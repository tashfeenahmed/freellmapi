# Updates and backup

Keeping a Docker deployment current, protecting the SQLite data volume, and making installs reproducible with declarative configuration.

- [Upgrading the container](#upgrading-the-container)
- [Dashboard update checker (#635 / #703)](#dashboard-update-checker-635--703)
- [Backing up the SQLite data volume](#backing-up-the-sqlite-data-volume)
- [Declarative config & catalog controls (#f4cd7b4)](#declarative-config--catalog-controls-f4cd7b4)

## Upgrading the container

Track `:latest` (or pin a release tag) and re-create the container on a new image:

```bash
docker compose pull && docker compose up -d
```

Two invariants across any upgrade:

1. **Keep the same `.env` `ENCRYPTION_KEY`.** Provider keys are encrypted at rest; a changed key makes every stored key undecryptable. See [02-security-and-keys.md](../env/02-security-and-keys.md).
2. **Keep the same data volume** (`freellmapi-data` at `/app/server/data`). Migrations run idempotently on boot.

The desktop dashboard's update dialog shows this exact command for Docker installs (see below).

## Dashboard update checker (#635 / #703)

Settings carries a single update surface: it reports the running release, lists recent commits, and — when the installation is Docker — prints the `docker compose pull && docker compose up -d` upgrade command. Relevant controls:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREELLMAPI_UPDATE_CHECK` | Enabled | Set to `off` to hide the checker from Settings and prevent Git discovery or outbound update-check requests. This also switches off the automatic release reminder, a separate dashboard setting (Settings > General) that is off until turned on there. |
| `FREELLMAPI_UPDATE_GITHUB_TOKEN` | Empty (anonymous checks) | Optional token used only for update checks against GitHub. Use a narrowly scoped token only if higher rate limits are needed; generic `GITHUB_TOKEN` values are intentionally ignored. |

Two build-level facts back the version display: `FREELLMAPI_INSTALL_METHOD=docker` tells the server which upgrade path to suggest, and the runtime image copies `desktop/package.json` — where the release version lives, since `server/package.json` tracks the workspace — as a ~400-byte manifest so a container install can name its own version (#703).

## Backing up the SQLite data volume

Everything that matters lives in one place: the named volume `freellmapi-data` mounted at `/app/server/data`, containing the SQLite database (`freeapi.db`, or wherever `FREEAPI_DB_PATH` points), its `-wal`/`-shm` sidecars, and the `.encryption-key` file for dev-style installs. Back up all of it together, and keep the matching `ENCRYPTION_KEY` safe — without it, backed-up provider keys are undecryptable ciphertext.

Built-in encrypted backups (recommended, zero downtime). FreeLLMAPI can push an encrypted backup of the live database on a schedule:

```env
FREEAPI_DB_BACKUP_PATH=/app/server/data/freellmapi.db.backup
# or:
FREEAPI_DB_BACKUP_URL=https://example.com/freellmapi.db.backup
FREEAPI_DB_BACKUP_TOKEN=optional-bearer-token
FREEAPI_DB_BACKUP_KEY=64-char-hex-backup-key        # defaults to ENCRYPTION_KEY
FREEAPI_DB_BACKUP_INTERVAL_MS=300000
```

Restore semantics: when the configured database file is missing at startup, FreeLLMAPI restores the backup before migrations run; while the server is running it uploads a fresh encrypted backup periodically. On hosts with ephemeral disks this is the primary protection.

Volume snapshot (plain Docker approach). The standard pattern works unchanged:

```bash
docker run --rm -v freellmapi-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/freellmapi-data.tar.gz -C /data .
```

Because the server keeps the database open (WAL mode), prefer doing this while the container is stopped (`docker compose stop`) so you capture a quiescent copy, then `docker compose start`.

## Declarative config & catalog controls (#f4cd7b4)

For repeatable Docker/server installs, FreeLLMAPI can apply a JSON config on every boot. Set `FREEAPI_CONFIG_PATH=/path/to/freellmapi.config.json`, or put the same JSON inline in `FREEAPI_CONFIG_JSON`. The application is idempotent: existing keys, custom providers, model edits, fallback rows, and routing settings are updated instead of duplicated, after migrations, on every boot.

```json
{
  "keys": [
    { "platform": "groq", "key": "gsk_...", "label": "main" },
    { "platform": "google", "key": "AIza...", "enabled": true }
  ],
  "customProviders": [
    {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "label": "Ollama",
      "models": [
        { "model": "llama3.1:8b", "displayName": "Local Llama", "supportsTools": true }
      ]
    }
  ],
  "models": [
    {
      "platform": "groq",
      "modelId": "llama-3.3-70b-versatile",
      "displayName": "Llama 3.3 70B",
      "supportsTools": true,
      "fallbackEnabled": true
    }
  ],
  "routing": { "strategy": "balanced" }
}
```

If two custom endpoints serve the same model id, add `"endpoint"` to a `models` or `fallback` entry to say which one you mean — the endpoint's URL, or the short handle the dashboard shows next to it. Without it, an entry that matches more than one endpoint is rejected rather than applied to an arbitrary one:

```json
{
  "models": [
    { "platform": "custom", "modelId": "deepseek-v3.1", "endpoint": "https://relay-b.example.com/v1", "enabled": false }
  ]
}
```

Catalog side: an install keeps its model roster current from the signed catalog feed (the full catalog is listed at freellmapi.co/models), so no manual roster maintenance is required alongside upgrades.
