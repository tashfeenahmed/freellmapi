# Security and key handling

How FreeLLMAPI protects the provider API keys you store in it, and how the `ENCRYPTION_KEY` that makes that protection real is generated, stored, and migrated.

Sources: [`.env.example`](../../.env.example) (key lifecycle comments), [`server/src/lib/crypto.ts`](../../server/src/lib/crypto.ts), and [`server/src/db/index.ts`](../../server/src/db/index.ts).

- [The encryption key at a glance](#the-encryption-key-at-a-glance)
- [Key resolution precedence](#key-resolution-precedence)
- [The dev auto-generated key file](#the-dev-auto-generated-key-file)
- [Why the key file is not in the database](#why-the-key-file-is-not-in-the-database)
- [At-rest encryption of provider keys](#at-rest-encryption-of-provider-keys)
- [Data directory hardening (WAL sidecars)](#data-directory-hardening-wal-sidecars)
- [First-run setup code](#first-run-setup-code)

## The encryption key at a glance

`ENCRYPTION_KEY` is the server-side key for API-key storage. It must be 64 hex characters — a 32-byte AES-256-GCM key. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

(or `openssl rand -hex 32`, as the Compose quickstart uses). The placeholder value from `.env.example` (`your-64-char-hex-key-here`) is never accepted as a real key.

A typo'd or short key fails fast with an actionable error instead of being silently truncated and only surfacing as a cryptic `node:crypto` failure on the first encrypt call.

## Key resolution precedence

On boot, after the database is initialized, the key is resolved in this order:

1. **`ENCRYPTION_KEY` env var** — always wins when set to a non-placeholder value.
2. **Key file** — a `.encryption-key` file next to the SQLite database.
3. **Legacy settings row** — older installs kept the key in a `settings` table row; it is migrated to the file on first boot, then deleted from the table.
4. **Freshly generated key** — written to the key file (outside production only; see below).

## The dev auto-generated key file

Outside production, `ENCRYPTION_KEY` is optional: when unset, a key is auto-generated and written to a file named `.encryption-key` next to the SQLite database — not inside it — with `0600` permissions. This exists so a fresh clone boots under `npm run dev` without manual setup; otherwise the placeholder in `.env.example` would crash the server on boot, which surfaces in the client as "Can't reach the server".

Production still requires an explicit env key: a generated key lives only on the local disk, and silently losing it would make every stored API key undecryptable.

Two write-safety details:

- The key file is written atomically via temp-file-and-rename, so a crash never leaves a half-written key.
- The temp file is restricted to owner-only permissions BEFORE the rename, so the key is never briefly world-readable under its final name; the rename carries the DACL with it, and a second restriction pass on the final path is idempotent belt-and-braces. If the final restriction cannot be applied, a warning is logged.

Do not rely on the fallback with real provider keys: set `ENCRYPTION_KEY`.

## Why the key file is not in the database

Storing the key beside the ciphertext it protects (the old `settings` row) meant encryption-at-rest protected nothing for a default install: whoever copied the DB also copied the key. The key file sits in the same directory but is a separate artifact, chmod `0600`, so copying the database alone no longer yields usable ciphertext. Legacy installs are migrated to this scheme automatically on first boot.

## At-rest encryption of provider keys

Stored provider keys are encrypted with AES-256-GCM using the resolved key. Consequences worth knowing:

- **Keep the same `ENCRYPTION_KEY` across restarts and upgrades.** Losing it makes every stored provider key undecryptable; there is no recovery path.
- The dashboard's key export exists for backup purposes; its rate limit is deliberately much tighter than the general `/api` flood guard (see [01-variables.md](01-variables.md#rate-limits)).
- The optional encrypted DB backup ([02-updates-and-backup.md](../deployment/02-updates-and-backup.md)) defaults its envelope key to `ENCRYPTION_KEY`; `FREEAPI_DB_BACKUP_KEY` can override that with a separate 64-char hex key.

## Data directory hardening (WAL sidecars)

SQLite creates `-wal` and `-shm` sidecar files on the first write and deletes them on the last clean close — so at startup there may be nothing there to chmod, and the files' protection has to come from the directory they live in. FreeLLMAPI therefore restricts the directory holding the database to the owning account before opening the connection (on Windows the ACL is inherited, so hardening first means the database file is born protected rather than spending its first moments with whatever ACL the parent handed down).

Because locking down a directory that is not ours would be a worse outage than the leak it prevents (pointing the DB at `/tmp/freeapi.db` must not chmod `0700` `/tmp`), hardening applies by ownership-by-construction:

1. The directory was just created by this process, or
2. It is the built-in default data directory (`server/data`), which ships as ours.

An operator pointing `FREEAPI_DB_PATH` at a dedicated pre-existing directory can opt in with `FREEAPI_DB_DIR_HARDENING=1`, and opt out entirely with `=0`. The default is default-on-where-safe rather than a required flag, because hardening that only runs when someone remembers to ask for it is the same class of failure as hardening nobody noticed had stopped running.

## First-run setup code

The first dashboard account is created through the UI. A browser on the same machine as the server can do this with no extra step. If the server is reachable from other devices, creating that first account also requires a one-time setup code, printed in the server logs at startup while no account exists — this stops a stranger from claiming a freshly exposed install.
