#!/usr/bin/env bash
# import-data.sh — Import a SQLite `.sql` backup into the FreeLLMAPI database.
#
# Usage:
#   ./scripts/import-data.sh                          # default: data/backup_full.sql
#   ./scripts/import-data.sh /path/to/backup.sql       # custom file

set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_FILE="${1:-data/backup_full.sql}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "Error: sqlite3 CLI not found. Install it first (apt install sqlite3)."
  exit 1
fi

# DB path: FREEAPI_DB_PATH (env or .env) overrides the default.
DB_PATH="${FREEAPI_DB_PATH:-server/data/freeapi.db}"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  DB_PATH="${FREEAPI_DB_PATH:-$DB_PATH}"
fi

mkdir -p "$(dirname "$DB_PATH")"

FILESIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Importing backup: $BACKUP_FILE ($FILESIZE) → $DB_PATH…"
sqlite3 "$DB_PATH" < "$BACKUP_FILE"
echo "Import complete: $BACKUP_FILE → $DB_PATH"
